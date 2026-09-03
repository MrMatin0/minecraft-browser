// Chunk shader (texture array, smooth lighting, biome tints, grass overlay, animated tiles, fog).
(function () {
  var VERT = [
    'precision highp float;',
    'in vec4 aData;',   // layer, overlayLayer, frames, sky*16+block
    'in vec4 aColor;',  // tint rgb, shade*ao
    'out vec2 vUv; out float vLayer; out float vOverlay; out vec4 vCol; out float vSky; out float vBlock; out float vFogDist;',
    'uniform float uTime; uniform vec3 uCamPos;',
    'void main() {',
    '  vUv = uv;',
    '  float fr = aData.z;',
    '  float layer = aData.x;',
    '  if (fr > 1.5) layer += mod(floor(uTime * 8.0), fr);',
    '  vLayer = layer; vOverlay = aData.y;',
    '  vCol = aColor;',
    '  float packed = aData.w;',
    '  vSky = floor(packed / 16.0 + 0.0001);',
    '  vBlock = packed - vSky * 16.0;',
    '  vec4 wp = modelMatrix * vec4(position, 1.0);',
    '  vFogDist = length(wp.xz - uCamPos.xz);',
    '  gl_Position = projectionMatrix * viewMatrix * wp;',
    '}'
  ].join('\n');
  var FRAG = [
    'precision highp float; precision highp sampler2DArray;',
    'uniform sampler2DArray uTex;',
    'uniform float uSkyLight; uniform vec3 uSkyTint; uniform vec3 uFogColor; uniform float uFogNear; uniform float uFogFar; uniform float uAlphaTest; uniform float uOpacity; uniform float uGamma;',
    'in vec2 vUv; in float vLayer; in float vOverlay; in vec4 vCol; in float vSky; in float vBlock; in float vFogDist;',
 'out vec4 fragColor;',
    'const vec3 BLOCK_LIGHT_COLOR = vec3(1.0, 0.92, 0.78);',
    'float curve(float l) { float f = l / 15.0; return f / (4.0 - 3.0 * f); }',
    'void main() {',
    '  vec4 tex = texture(uTex, vec3(vUv, vLayer));',
    '  if (tex.a < uAlphaTest) discard;',           // discard first: skips the overlay fetch + lighting math entirely
    '  vec3 col;',
    '  if (vOverlay > 0.5) { vec4 ov = texture(uTex, vec3(vUv, vOverlay)); col = mix(tex.rgb, ov.rgb * vCol.rgb, ov.a); }',
    '  else col = tex.rgb * vCol.rgb;',
    '  vec3 light = max(vec3(curve(vSky) * uSkyLight) * uSkyTint, vec3(curve(vBlock)) * BLOCK_LIGHT_COLOR);',
    '  light = max(light, vec3(0.035));',
    '  light = pow(light, vec3(1.0 / (1.0 + uGamma * 0.6)));',
    '  col *= light * vCol.a;',
    '  col = mix(col, uFogColor, smoothstep(uFogNear, uFogFar, vFogDist));',
    '  fragColor = vec4(col, tex.a * uOpacity);',
    '}'
  ].join('\n');

  function createChunkMaterials(texArray) {
    var uniforms = {
      uTex: { value: texArray }, uTime: { value: 0 }, uCamPos: { value: new THREE.Vector3() },
      uSkyLight: { value: 1 }, uSkyTint: { value: new THREE.Vector3(1, 1, 1) }, uFogColor: { value: new THREE.Vector3(0.75, 0.85, 1) },
      uFogNear: { value: 100 }, uFogFar: { value: 140 }, uGamma: { value: 0.5 }
    };
    // Each material gets its own uAlphaTest/uOpacity but *shares* every other uniform
    // object with `uniforms`, so updating uTime/uCamPos/fog once updates all three.
    function mk(alphaTest, opacity, transparent, side) {
      var u = Object.assign({}, uniforms, { uAlphaTest: { value: alphaTest }, uOpacity: { value: opacity } });
      return new THREE.ShaderMaterial({ glslVersion: THREE.GLSL3, vertexShader: VERT, fragmentShader: FRAG, uniforms: u, transparent: !!transparent, side: side || THREE.FrontSide, depthWrite: true });
    }
    return {
      opaque: mk(0.0, 1.0, false, THREE.FrontSide),
      cutout: mk(0.5, 1.0, false, THREE.DoubleSide),
      water: mk(0.0, 1.0, true, THREE.DoubleSide),
      uniforms: uniforms,
      // Build an extra material off the same shader + shared uniforms. Used for the block
      // break overlay, which previously cloned `cutout` and then mutated cutout's own
      // uniforms object -- silently changing the alpha test for every cutout block.
      variant: function (opts) {
        var u = Object.assign({}, uniforms, { uAlphaTest: { value: opts.alphaTest === undefined ? 0.5 : opts.alphaTest }, uOpacity: { value: opts.opacity === undefined ? 1 : opts.opacity } });
        return new THREE.ShaderMaterial({
          glslVersion: THREE.GLSL3, vertexShader: VERT, fragmentShader: FRAG, uniforms: u,
          transparent: !!opts.transparent, depthWrite: !!opts.depthWrite, side: opts.side || THREE.FrontSide,
          polygonOffset: !!opts.polygonOffset, polygonOffsetFactor: opts.polygonOffsetFactor || 0, polygonOffsetUnits: opts.polygonOffsetUnits || 0
        });
      }
    };
  }

  // Entity material: vertex colors baked with face shading; uLight scales brightness (block light at entity pos)
  var EVERT = [
    'precision highp float; in vec3 aShade; out vec2 vUv; out float vShade; out float vFogDist; uniform vec3 uCamPos;',
    'void main(){ vUv = uv; vShade = aShade.x; vec4 wp = modelMatrix * vec4(position,1.0); vFogDist = length(wp.xz - uCamPos.xz); gl_Position = projectionMatrix * viewMatrix * wp; }'
  ].join('\n');
  var EFRAG = [
    'precision highp float; uniform sampler2D uMap; uniform float uLight; uniform vec3 uTint; uniform float uHurt; uniform vec3 uFogColor; uniform float uFogNear; uniform float uFogFar; uniform float uAlpha;',
    'in vec2 vUv; in float vShade; in float vFogDist; out vec4 fragColor;',
    'void main(){ vec4 t = texture(uMap, vUv); if (t.a < 0.5) discard; vec3 col = t.rgb * uTint * vShade * uLight; col = mix(col, vec3(1.0,0.3,0.3), uHurt * 0.5); col = mix(col, uFogColor, smoothstep(uFogNear, uFogFar, vFogDist)); fragColor = vec4(col, uAlpha); }'
  ].join('\n');
  function createEntityMaterial(map, shared) {
    var u = { uMap: { value: map }, uLight: { value: 1 }, uTint: { value: new THREE.Vector3(1, 1, 1) }, uHurt: { value: 0 }, uAlpha: { value: 1 }, uCamPos: shared.uCamPos, uFogColor: shared.uFogColor, uFogNear: shared.uFogNear, uFogFar: shared.uFogFar };
    return new THREE.ShaderMaterial({ glslVersion: THREE.GLSL3, vertexShader: EVERT, fragmentShader: EFRAG, uniforms: u, side: THREE.DoubleSide });
  }
  MC.Shaders = { createChunkMaterials: createChunkMaterials, createEntityMaterial: createEntityMaterial };
})();

// Entities: block/item meshes, item drops, falling blocks, primed TNT, particles, explosions.
(function () {
  // ---------- single block geometry using chunk material attributes ----------
  var FACE = [
    { n: [1, 0, 0], c: [[1, 0, 1], [1, 0, 0], [1, 1, 0], [1, 1, 1]], shade: 0.6 },
    { n: [-1, 0, 0], c: [[0, 0, 0], [0, 0, 1], [0, 1, 1], [0, 1, 0]], shade: 0.6 },
    { n: [0, 1, 0], c: [[0, 1, 1], [1, 1, 1], [1, 1, 0], [0, 1, 0]], shade: 1.0 },
    { n: [0, -1, 0], c: [[0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1]], shade: 0.5 },
    { n: [0, 0, 1], c: [[0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]], shade: 0.8 },
    { n: [0, 0, -1], c: [[1, 0, 0], [0, 0, 0], [0, 1, 0], [1, 1, 0]], shade: 0.8 }
  ];
  var UV = [[0, 1], [1, 1], [1, 0], [0, 0]], UVB = [[0, 0], [1, 0], [1, 1], [0, 1]];
  // Scratch vectors for the per-frame / per-explosion math below.
  var _v1 = new THREE.Vector3(), _v2 = new THREE.Vector3(), _center = new THREE.Vector3();
  var DIRECTIONAL = { furnace: 1, crafting_table: 1, jack_o_lantern: 1, carved_pumpkin: 1, chest: 1 };

  var geoCache = {};
  function blockGeometry(id, meta, light) {
    light = light === undefined ? 15 : light;
    var key = id + ':' + (meta || 0) + ':' + light; if (geoCache[key]) return geoCache[key];
    var B = MC.BLOCKS[id]; var pos = [], uv = [], data = [], col = [], idx = [], n = 0;
    var tint = [1, 1, 1];
    if (B.tint === 'grass') { var g = MC.BIOMES[1].grass; tint = [g[0] / 255, g[1] / 255, g[2] / 255]; }
    else if (B.tint === 'foliage') { var f0 = MC.BIOMES[1].foliage; tint = [f0[0] / 255, f0[1] / 255, f0[2] / 255]; }
    else if (B.tint === 'water') { var w = MC.BIOMES[1].water; tint = [w[0] / 255, w[1] / 255, w[2] / 255]; }
    else if (MC.STATIC_TINT[B.tint]) { var s = MC.STATIC_TINT[B.tint]; tint = [s[0] / 255, s[1] / 255, s[2] / 255]; }
    var frames = B.anim ? MC.Tex.frames(B.faces[0]) : 1;
    function quad(v, uvs, layer, overlay, t, shade) {
      for (var i = 0; i < 4; i++) { pos.push(v[i][0] - 0.5, v[i][1] - 0.5, v[i][2] - 0.5); uv.push(uvs[i][0], uvs[i][1]); data.push(layer, overlay, frames, light * 16); col.push(t[0], t[1], t[2], shade); }
      idx.push(n, n + 1, n + 2, n, n + 2, n + 3); n += 4;
    }
    if (B.model === 'cross') {
      var lay = MC.Tex.layer(B.faces[0]);
      quad([[0.15, 0, 0.15], [0.85, 0, 0.85], [0.85, 1, 0.85], [0.15, 1, 0.15]], UV, lay, 0, tint, 1);
      quad([[0.85, 0, 0.15], [0.15, 0, 0.85], [0.15, 1, 0.85], [0.85, 1, 0.15]], UV, lay, 0, tint, 1);
    } else if (B.model === 'torch') {
      var lay2 = MC.Tex.layer('torch');
      for (var f = 0; f < 6; f++) { var F = FACE[f]; var v = []; for (var k = 0; k < 4; k++) { var cc = F.c[k]; v.push([cc[0] ? 9 / 16 : 7 / 16, cc[1] ? 10 / 16 : 0, cc[2] ? 9 / 16 : 7 / 16]); } var r = (f === 2 || f === 3) ? [7 / 16, 6 / 16, 9 / 16, 8 / 16] : [7 / 16, 6 / 16, 9 / 16, 1]; quad(v, [[r[0], r[3]], [r[2], r[3]], [r[2], r[1]], [r[0], r[1]]], lay2, 0, tint, F.shade); }
    } else {
      var h = B.model === 'layer' ? 2 / 16 : (B.model === 'liquid' ? 0.875 : 1);
      var inset = B.model === 'cactus' ? 1 / 16 : 0;
      for (f = 0; f < 6; f++) {
        F = FACE[f]; v = [];
        for (k = 0; k < 4; k++) { cc = F.c[k]; v.push([cc[0] ? 1 - (F.n[0] ? inset : 0) : (F.n[0] ? inset : 0), cc[1] ? h : 0, cc[2] ? 1 - (F.n[2] ? inset : 0) : (F.n[2] ? inset : 0)]); }
        var layer = MC.Tex.layer(B.faces[f]), overlay = 0, t = tint;
        if (B.sideOverlay) { if (f === 3) t = [1, 1, 1]; else if (f !== 2) overlay = MC.Tex.layer('grass_block_side_overlay'); }
        else if (B.tint === 'grass' && f === 3) t = [1, 1, 1];
        if (B.hasMeta && DIRECTIONAL[B.name]) layer = (f === 4 || f === 2 || f === 3) ? MC.Tex.layer(B.faces[f]) : MC.Tex.layer(B.faces[0]);
        quad(v, f === 3 ? UVB : UV, layer, overlay, t, F.shade);
      }
    }
    var geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(uv), 2));
    geo.setAttribute('aData', new THREE.BufferAttribute(new Float32Array(data), 4));
    geo.setAttribute('aColor', new THREE.BufferAttribute(new Float32Array(col), 4));
    geo.setIndex(idx);
    geo.computeBoundingSphere();
    geoCache[key] = geo; return geo;
  }
  function blockMaterialFor(id, mats) { var B = MC.BLOCKS[id]; return B.translucent ? mats.water : (B.cutout ? mats.cutout : mats.opaque); }
  function blockMesh(id, meta, mats) { return new THREE.Mesh(blockGeometry(id, meta), blockMaterialFor(id, mats)); }

  // A material that renders like an opaque chunk but owns its own uSkyLight, so an entity
  // can flash without touching the world's shared lighting uniform. Everything else
  // (texture, time, camera, fog) stays shared so it tracks the world live.
  function ownLightMaterial(mats) {
    var u = mats.opaque.uniforms;
    return new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: mats.opaque.vertexShader,
      fragmentShader: mats.opaque.fragmentShader,
      uniforms: {
        uTex: u.uTex, uTime: u.uTime, uCamPos: u.uCamPos, uSkyTint: u.uSkyTint,
        uFogColor: u.uFogColor, uFogNear: u.uFogNear, uFogFar: u.uFogFar, uGamma: u.uGamma,
        uSkyLight: { value: 1 }, uAlphaTest: { value: 0 }, uOpacity: { value: 1 }
      },
      side: THREE.FrontSide, depthWrite: true
    });
  }

  // ---------- extruded item sprite ----------
  var itemGeoCache = {}, itemTexCache = {}, itemMatCache = {}, flatBlockCache = {};
  function itemTexture(name) {
    if (itemTexCache[name]) return itemTexCache[name];
    var cv = MC.ItemIcons.get(name) || MC.ItemIcons.get('missing');
    var tex = new THREE.CanvasTexture(cv); tex.magFilter = THREE.NearestFilter; tex.minFilter = THREE.NearestFilter; tex.colorSpace = THREE.SRGBColorSpace; tex.flipY = false;
    itemTexCache[name] = tex; return tex;
  }
  function itemGeometry(name) {
    if (itemGeoCache[name]) return itemGeoCache[name];
    var cv = MC.ItemIcons.get(name) || MC.ItemIcons.get('missing');
    var d = cv.getContext('2d').getImageData(0, 0, 16, 16).data;
    function alphaAt(x, y) { if (x < 0 || y < 0 || x > 15 || y > 15) return 0; return d[(y * 16 + x) * 4 + 3]; }
    var pos = [], uv = [], col = [], idx = [], n = 0; var T = 1 / 16;
    var cr = 1, cg = 1, cb = 1;
    // hoisted out of the 16x16 loop below (it was allocating a closure per pixel)
    function q(ax, ay, az, bx, by, bz, cx, cy, cz, dx, dy, dz, sh) {
      pos.push(ax, ay, az, bx, by, bz, cx, cy, cz, dx, dy, dz);
      for (var k = 0; k < 4; k++) { uv.push(0, 0); col.push(cr * sh, cg * sh, cb * sh); }
      idx.push(n, n + 1, n + 2, n, n + 2, n + 3); n += 4;
    }
    // front and back quads (textured)
    pos.push(0, 0, T / 2, 1, 0, T / 2, 1, 1, T / 2, 0, 1, T / 2); uv.push(0, 1, 1, 1, 1, 0, 0, 0); idx.push(0, 1, 2, 0, 2, 3);
    pos.push(1, 0, -T / 2, 0, 0, -T / 2, 0, 1, -T / 2, 1, 1, -T / 2); uv.push(1, 1, 0, 1, 0, 0, 1, 0); idx.push(4, 5, 6, 4, 6, 7);
    for (var i = 0; i < 8; i++) col.push(1, 1, 1);
    n = 8;
    var start = idx.length;
    // edges (vertex colored)
    for (var y = 0; y < 16; y++) for (var x = 0; x < 16; x++) {
      if (alphaAt(x, y) < 128) continue;
      var o = (y * 16 + x) * 4;
      cr = d[o] / 255; cg = d[o + 1] / 255; cb = d[o + 2] / 255;
      var x0 = x * T, x1 = x0 + T, y0 = 1 - (y + 1) * T, y1 = y0 + T;
      if (alphaAt(x + 1, y) < 128) q(x1, y0, T / 2, x1, y0, -T / 2, x1, y1, -T / 2, x1, y1, T / 2, 0.8);
      if (alphaAt(x - 1, y) < 128) q(x0, y0, -T / 2, x0, y0, T / 2, x0, y1, T / 2, x0, y1, -T / 2, 0.8);
      if (alphaAt(x, y - 1) < 128) q(x0, y1, T / 2, x1, y1, T / 2, x1, y1, -T / 2, x0, y1, -T / 2, 1.0);
      if (alphaAt(x, y + 1) < 128) q(x0, y0, -T / 2, x1, y0, -T / 2, x1, y0, T / 2, x0, y0, T / 2, 0.6);
    }
    var geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(uv), 2));
    geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(col), 3));
    geo.setIndex(idx);
    geo.addGroup(0, start, 0); geo.addGroup(start, idx.length - start, 1);
    geo.translate(-0.5, -0.5, 0);
    itemGeoCache[name] = geo; return geo;
  }
  var edgeMat = null;
  function itemMaterials(name) {
    var m = itemMatCache[name];
    if (!m) {
      if (!edgeMat) edgeMat = new THREE.MeshBasicMaterial({ vertexColors: true, fog: false });
      m = itemMatCache[name] = [new THREE.MeshBasicMaterial({ map: itemTexture(name), alphaTest: 0.5, side: THREE.DoubleSide, fog: false }), edgeMat];
    }
    return m;
  }
  function itemMesh(name) { return new THREE.Mesh(itemGeometry(name), itemMaterials(name)); }
  // Flat blocks (flowers, saplings, ...) render as a textured quad. Geometry, texture and
  // material are cached per block -- they used to be rebuilt for every single dropped item.
  function flatBlockParts(blockId) {
    var parts = flatBlockCache[blockId];
    if (!parts) {
      var B = MC.BLOCKS[blockId];
      var cv = B.tint ? MC.Tex.tintedTileCanvas(B.faces[0], B.tint === 'grass' ? MC.BIOMES[1].grass : MC.BIOMES[1].foliage) : MC.Tex.tileCanvas(B.faces[0]);
      var tex = new THREE.CanvasTexture(cv); tex.magFilter = THREE.NearestFilter; tex.minFilter = THREE.NearestFilter; tex.colorSpace = THREE.SRGBColorSpace;
      parts = flatBlockCache[blockId] = { geo: new THREE.PlaneGeometry(1, 1), mat: new THREE.MeshBasicMaterial({ map: tex, alphaTest: 0.5, side: THREE.DoubleSide, fog: false }) };
    }
    return parts;
  }
  // mesh for any item stack (block -> cube; flat block or item -> sprite)
  function stackMesh(itemName, mats) {
    var it = MC.ITEMS[itemName]; if (!it) return itemMesh('missing');
    if (it.block >= 0) {
      if (!MC.BLOCKS[it.block].flat) return blockMesh(it.block, 0, mats);
      var parts = flatBlockParts(it.block);
      var g = new THREE.Group(); g.add(new THREE.Mesh(parts.geo, parts.mat)); return g;
    }
    return itemMesh(itemName);
  }

  // ---------- entity manager ----------
  function Entities(world, scene, mats) { this.world = world; this.scene = scene; this.mats = mats; this.list = []; this.game = null; }
  Entities.prototype.add = function (e) { this.list.push(e); if (e.mesh) this.scene.add(e.mesh); return e; };
  Entities.prototype.remove = function (e) {
    var i = this.list.indexOf(e); if (i >= 0) this.list.splice(i, 1);
    if (e.mesh) this.scene.remove(e.mesh);
    if (e.dispose) e.dispose();
    e.dead = true;
  };
  Entities.prototype.update = function (dt, player, dayLight) {
    for (var i = this.list.length - 1; i >= 0; i--) {
      var e = this.list[i]; e.update(dt, player, this);
      if (e.dead) this.remove(e);
      else if (e.mesh && e.setLight) e.setLight(this.world.brightnessAt(e.pos.x, e.pos.y + 0.5, e.pos.z, dayLight));
    }
  };
  Entities.prototype.clear = function () { for (var i = this.list.length - 1; i >= 0; i--) this.remove(this.list[i]); };
  // simple AABB physics for small entities (w = width, h = height), returns onGround
  var boxes = [];
  Entities.prototype.moveEntity = function (e, dt) {
    var w = e.width / 2, h = e.height;
    var p = e.pos, v = e.vel;
    // Y
    var dy = v.y * dt;
    this.world.collectBoxes(p.x - w, p.y + Math.min(0, dy), p.z - w, p.x + w, p.y + h + Math.max(0, dy), p.z + w, boxes);
    e.onGround = false;
    for (var i = 0; i < boxes.length; i++) { var b = boxes[i]; if (p.x + w <= b[0] || p.x - w >= b[3] || p.z + w <= b[2] || p.z - w >= b[5]) continue; if (dy < 0 && p.y >= b[4] && p.y + dy < b[4]) { dy = b[4] - p.y; v.y = 0; e.onGround = true; } else if (dy > 0 && p.y + h <= b[1] && p.y + h + dy > b[1]) { dy = b[1] - (p.y + h); v.y = 0; } }
    p.y += dy;
    // X
    var dx = v.x * dt;
    this.world.collectBoxes(p.x - w + Math.min(0, dx), p.y, p.z - w, p.x + w + Math.max(0, dx), p.y + h, p.z + w, boxes);
    for (i = 0; i < boxes.length; i++) { b = boxes[i]; if (p.y + h <= b[1] || p.y >= b[4] || p.z + w <= b[2] || p.z - w >= b[5]) continue; if (dx > 0 && p.x + w <= b[0] && p.x + w + dx > b[0]) { dx = b[0] - (p.x + w); v.x = 0; } else if (dx < 0 && p.x - w >= b[3] && p.x - w + dx < b[3]) { dx = b[3] - (p.x - w); v.x = 0; } }
    p.x += dx;
    var dz = v.z * dt;
    this.world.collectBoxes(p.x - w, p.y, p.z - w + Math.min(0, dz), p.x + w, p.y + h, p.z + w + Math.max(0, dz), boxes);
    for (i = 0; i < boxes.length; i++) { b = boxes[i]; if (p.y + h <= b[1] || p.y >= b[4] || p.x + w <= b[0] || p.x - w >= b[3]) continue; if (dz > 0 && p.z + w <= b[2] && p.z + w + dz > b[2]) { dz = b[2] - (p.z + w); v.z = 0; } else if (dz < 0 && p.z - w >= b[5] && p.z - w + dz < b[5]) { dz = b[5] - (p.z - w); v.z = 0; } }
    p.z += dz;
    return e.onGround;
  };
  Entities.prototype.inWater = function (x, y, z) { return this.world.getBlock(Math.floor(x), Math.floor(y), Math.floor(z)) === MC.BLOCK.water.id; };

  // Collect the uLight uniforms under a mesh once, instead of traversing every frame.
  function collectLightUniforms(root) {
    var out = [];
    root.traverse(function (o) { if (o.material && o.material.uniforms && o.material.uniforms.uLight) out.push(o.material.uniforms.uLight); });
    return out;
  }

  // ---------- Item drop ----------
  function ItemDrop(ents, stack, pos, vel) {
    this.ents = ents; this.stack = stack; this.pos = pos.clone(); this.vel = vel ? vel.clone() : new THREE.Vector3((Math.random() - 0.5) * 2, 3, (Math.random() - 0.5) * 2);
    this.width = 0.25; this.height = 0.25; this.age = 0; this.pickupDelay = 0.5; this.onGround = false; this.dead = false;
    this.mesh = new THREE.Group(); this.inner = stackMesh(stack.id, ents.mats);
    var it = MC.ITEMS[stack.id]; var isBlock = it && it.block >= 0 && !MC.BLOCKS[it.block].flat;
    this.inner.scale.setScalar(isBlock ? 0.25 : 0.5); this.isBlock = isBlock;
    if (stack.count > 1 && isBlock) { var extra = stackMesh(stack.id, ents.mats); extra.scale.setScalar(0.25); extra.position.set(0.12, 0.08, 0.1); extra.rotation.y = 0.5; this.mesh.add(extra); }
    this.mesh.add(this.inner); this.spin = Math.random() * Math.PI * 2;
    this.lightUniforms = null;
  }
  ItemDrop.prototype.update = function (dt, player, ents) {
    this.age += dt; this.pickupDelay -= dt;
    if (this.age > 300) { this.dead = true; return; }
    if (ents.inWater(this.pos.x, this.pos.y + 0.1, this.pos.z)) { this.vel.y += (1.5 - this.vel.y) * Math.min(1, dt * 4); this.vel.x *= 0.9; this.vel.z *= 0.9; }
    else this.vel.y -= 16 * dt;
    if (this.onGround) { this.vel.x *= Math.pow(0.05, dt); this.vel.z *= Math.pow(0.05, dt); }
    ents.moveEntity(this, dt);
    // escape from inside a block
    var bid = ents.world.getBlock(Math.floor(this.pos.x), Math.floor(this.pos.y + 0.1), Math.floor(this.pos.z));
    if (bid > 0 && MC.BLOCKS[bid].solid && MC.BLOCKS[bid].fullCube) this.pos.y += dt * 2;
    this.spin += dt * 1.5;
    var bob = Math.sin(this.age * 2) * 0.05 + 0.1;
    this.mesh.position.set(this.pos.x, this.pos.y + (this.isBlock ? 0.125 : 0.25) + bob, this.pos.z);
    this.mesh.rotation.y = this.spin;
    if (this.pickupDelay <= 0 && player && !player.dead) {
      var dx = player.pos.x - this.pos.x, dy = (player.pos.y + 0.9) - this.pos.y, dz = player.pos.z - this.pos.z;
      if (dx * dx + dy * dy + dz * dz < 1.6 * 1.6) {
        var left = player.inventory.add(this.stack.id, this.stack.count, this.stack.damage);
        if (left < this.stack.count) { MC.Audio.play('random.pop', { pitch: 0.8 + Math.random() * 0.4 }); if (player.onPickup) player.onPickup(this); }
        if (left <= 0) this.dead = true; else this.stack.count = left;
      }
    }
  };
  ItemDrop.prototype.setLight = function (b) {
    if (!this.lightUniforms) this.lightUniforms = collectLightUniforms(this.mesh);
    for (var i = 0; i < this.lightUniforms.length; i++) this.lightUniforms[i].value = b;
  };

  // ---------- XP orb ----------
  function XPOrb(ents, pos, value) {
    this.pos = pos.clone(); this.vel = new THREE.Vector3((Math.random() - 0.5) * 2, 2 + Math.random(), (Math.random() - 0.5) * 2); this.value = value; this.age = 0; this.width = 0.3; this.height = 0.3; this.dead = false;
    var geo = XPOrb.geometry || (XPOrb.geometry = new THREE.PlaneGeometry(0.3, 0.3));
    var tex = XPOrb.texture || (XPOrb.texture = (function () { var c = document.createElement('canvas'); c.width = 8; c.height = 8; var x = c.getContext('2d'); x.fillStyle = '#7fe63f'; x.fillRect(1, 1, 6, 6); x.fillStyle = '#e8ffb0'; x.fillRect(2, 2, 2, 2); x.clearRect(0, 0, 1, 1); x.clearRect(7, 0, 1, 1); x.clearRect(0, 7, 1, 1); x.clearRect(7, 7, 1, 1); var t = new THREE.CanvasTexture(c); t.magFilter = THREE.NearestFilter; return t; })());
    this.mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ map: tex, transparent: true, fog: false, depthWrite: false })); this.onGround = false;
  }
  XPOrb.prototype.dispose = function () { if (this.mesh) this.mesh.material.dispose(); };
  XPOrb.prototype.update = function (dt, player, ents) {
    this.age += dt; if (this.age > 120) { this.dead = true; return; }
    this.vel.y -= 12 * dt; if (this.onGround) { this.vel.x *= Math.pow(0.02, dt); this.vel.z *= Math.pow(0.02, dt); }
    if (player && !player.dead) {
      var dx = player.pos.x - this.pos.x, dy = player.pos.y + 0.9 - this.pos.y, dz = player.pos.z - this.pos.z;
      var d = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (d < 7 && this.age > 0.4) { var k = (1 - d / 7) * 30 * dt / d; this.vel.x += dx * k; this.vel.y += dy * k; this.vel.z += dz * k; }
      if (d < 0.9 && this.age > 0.4) { player.addXP(this.value); MC.Audio.play('random.orb', { pitch: 0.9 + Math.random() * 0.3 }); this.dead = true; return; }
    }
    ents.moveEntity(this, dt);
    this.mesh.position.set(this.pos.x, this.pos.y + 0.15, this.pos.z);
    if (player) { _v1.copy(player.pos); _v1.y += player.eyeHeight; this.mesh.lookAt(_v1); }
    this.mesh.material.color.setHSL(0.25 + ((this.age * 2) % 1) * 0.12, 1, 0.6);
  };

  // ---------- Falling block ----------
  function FallingBlock(ents, id, meta, x, y, z) {
    this.id = id; this.meta = meta; this.pos = new THREE.Vector3(x + 0.5, y, z + 0.5); this.vel = new THREE.Vector3(); this.width = 0.98; this.height = 0.98; this.dead = false; this.onGround = false; this.age = 0;
    this.mesh = blockMesh(id, meta, ents.mats);
  }
  FallingBlock.prototype.update = function (dt, player, ents) {
    this.age += dt; this.vel.y -= 16 * dt;
    ents.moveEntity(this, dt);
    this.mesh.position.set(this.pos.x, this.pos.y + 0.5, this.pos.z);
    if (this.onGround || this.age > 30) {
      var bx = Math.floor(this.pos.x), by = Math.round(this.pos.y), bz = Math.floor(this.pos.z);
      var cur = ents.world.getBlock(bx, by, bz);
      if (cur === 0 || (cur > 0 && MC.BLOCKS[cur].replaceable)) ents.world.setBlock(bx, by, bz, this.id, this.meta);
      else ents.add(new ItemDrop(ents, { id: MC.BLOCKS[this.id].name, count: 1 }, this.pos));
      MC.Audio.play('dig.' + MC.BLOCKS[this.id].sound, { pos: this.pos, volume: 0.5 });
      this.dead = true;
    }
  };

  // ---------- Primed TNT ----------
  function PrimedTNT(ents, x, y, z, fuse) {
    this.pos = new THREE.Vector3(x + 0.5, y, z + 0.5); this.vel = new THREE.Vector3((Math.random() - 0.5) * 0.4, 4, (Math.random() - 0.5) * 0.4); this.width = 0.98; this.height = 0.98; this.fuse = fuse || 4; this.dead = false; this.onGround = false;
    // Own uSkyLight for the flash; every other uniform stays shared with the world so the
    // block keeps tracking the real camera position and fog (cloning broke that).
    this.material = ownLightMaterial(ents.mats);
    this.mesh = new THREE.Mesh(blockGeometry(MC.BLOCK.tnt.id, 0), this.material);
    this.flash = 0;
    MC.Audio.play('fire.ignite', { pos: this.pos });
  }
  PrimedTNT.prototype.dispose = function () { if (this.material) { this.material.dispose(); this.material = null; } };
  PrimedTNT.prototype.update = function (dt, player, ents) {
    this.fuse -= dt; this.vel.y -= 16 * dt; if (this.onGround) { this.vel.x *= 0.8; this.vel.z *= 0.8; }
    ents.moveEntity(this, dt);
    var s = 1 + Math.max(0, Math.sin(this.fuse * 12)) * 0.1;
    this.mesh.position.set(this.pos.x, this.pos.y + 0.5, this.pos.z); this.mesh.scale.setScalar(s);
    this.material.uniforms.uSkyLight.value = (Math.floor(this.fuse * 8) % 2 === 0) ? 3 : 1;
    if (this.fuse <= 0) { this.dead = true; ents.explode(this.pos.x, this.pos.y + 0.5, this.pos.z, 4, player); }
  };

  // ---------- Explosion ----------
  var BLAST_PROOF = { obsidian: 1, water: 1, lava: 1 };
  Entities.prototype.explode = function (x, y, z, power, player) {
    var world = this.world; var list = [];
    // `MC.Game` is the constructor -- dropsFor lives on its prototype, so the old
    // `MC.Game.dropsFor` check was always false and explosions never dropped anything.
    var game = this.game || MC.game;
    var r = Math.ceil(power * 1.3);
    var ox = Math.floor(x), oy = Math.floor(y), oz = Math.floor(z);
    for (var dx = -r; dx <= r; dx++) for (var dy = -r; dy <= r; dy++) for (var dz = -r; dz <= r; dz++) {
      var d = Math.sqrt(dx * dx + dy * dy + dz * dz); if (d > power * (0.9 + Math.random() * 0.4)) continue;
      var bx = ox + dx, by = oy + dy, bz = oz + dz;
      var id = world.getBlock(bx, by, bz); if (id <= 0) continue; var B = MC.BLOCKS[id];
      if (B.hardness < 0 || BLAST_PROOF[B.name]) continue;
      if (B.name === 'tnt') { this.add(new PrimedTNT(this, bx, by, bz, 0.5 + Math.random())); list.push(bx, by, bz, 0, 0); continue; }
      list.push(bx, by, bz, 0, 0);
      if (Math.random() < 0.3 && B.drops && game && game.dropsFor) {
        var drops = game.dropsFor(id, null, true);
        for (var k = 0; k < drops.length; k++) this.add(new ItemDrop(this, drops[k], _v2.set(bx + 0.5, by + 0.5, bz + 0.5)));
      }
    }
    if (list.length) world.setBlocks(list);
    _center.set(x, y, z);
    MC.Audio.play('explode', { pos: _center, volume: 1 });
    MC.Particles.explosion(x, y, z, power);
    // damage entities + player
    var maxR = power * 2, maxR2 = maxR * maxR;
    function hurtAt(e, ex, ey, ez) {
      var ddx = ex - x, ddy = ey - y, ddz = ez - z;
      var d2 = ddx * ddx + ddy * ddy + ddz * ddz; if (d2 > maxR2) return;
      var impact = 1 - Math.sqrt(d2) / maxR;
      var dmg = Math.floor((impact * impact + impact) * 7 * power + 1);
      if (e.hurt) e.hurt(dmg, 'explosion', _center, impact * 2);
    }
    if (player && !player.dead) hurtAt(player, player.pos.x, player.pos.y + 0.9, player.pos.z);
    if (MC.Mobs) { var mobs = MC.Mobs.list; for (var i = 0; i < mobs.length; i++) { var m = mobs[i]; hurtAt(m, m.pos.x, m.pos.y + m.height / 2, m.pos.z); } }
    if (this.game && this.game.onExplosion) this.game.onExplosion(_center, power);
  };

  // ---------- Particles (block fragments, smoke, explosion) using the texture array ----------
  // Mark only [0, n) dirty. Flagging the whole attribute re-uploaded all 4000 slots every
  // frame even when a dozen particles were alive.
  function markRange(attr, count) {
    attr.needsUpdate = true;
    if (attr.addUpdateRange) { attr.clearUpdateRanges(); attr.addUpdateRange(0, count * attr.itemSize); }
    else if (attr.updateRange) { attr.updateRange.offset = 0; attr.updateRange.count = count * attr.itemSize; }
  }
  function Particles(scene, texArray, shared) {
    this.max = 4000; this.n = 0; this.scene = scene;
    this.pos = new Float32Array(this.max * 3); this.uvo = new Float32Array(this.max * 2); this.layer = new Float32Array(this.max); this.size = new Float32Array(this.max); this.col = new Float32Array(this.max * 3);
    this.vel = new Float32Array(this.max * 3); this.life = new Float32Array(this.max); this.maxLife = new Float32Array(this.max); this.grav = new Float32Array(this.max); this.kind = new Uint8Array(this.max);
    var geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3)); geo.setAttribute('aUV', new THREE.BufferAttribute(this.uvo, 2)); geo.setAttribute('aLayer', new THREE.BufferAttribute(this.layer, 1)); geo.setAttribute('aSize', new THREE.BufferAttribute(this.size, 1)); geo.setAttribute('aCol', new THREE.BufferAttribute(this.col, 3));
    geo.setDrawRange(0, 0);
    var mat = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      uniforms: { uTex: { value: texArray }, uLight: { value: 1 }, uFogColor: shared.uFogColor, uFogNear: shared.uFogNear, uFogFar: shared.uFogFar, uCamPos: shared.uCamPos, uScreenH: { value: 900 } },
      vertexShader: 'precision highp float; in vec2 aUV; in float aLayer; in float aSize; in vec3 aCol; out vec2 vUV; out float vLayer; out vec3 vCol; out float vFog; uniform vec3 uCamPos; uniform float uFogNear; uniform float uFogFar; uniform float uScreenH; void main(){ vUV = aUV; vLayer = aLayer; vCol = aCol; vec4 wp = modelMatrix * vec4(position,1.0); vFog = smoothstep(uFogNear, uFogFar, length(wp.xz - uCamPos.xz)); vec4 mv = viewMatrix * wp; gl_Position = projectionMatrix * mv; gl_PointSize = aSize * uScreenH / max(0.1, -mv.z); }',
      fragmentShader: 'precision highp float; precision highp sampler2DArray; uniform sampler2DArray uTex; uniform vec3 uFogColor; in vec2 vUV; in float vLayer; in vec3 vCol; in float vFog; out vec4 fragColor; void main(){ vec4 t = vLayer < 0.0 ? vec4(1.0) : texture(uTex, vec3(vUV + gl_PointCoord * 0.25, vLayer)); if (t.a < 0.5) discard; fragColor = vec4(mix(t.rgb * vCol, uFogColor, vFog), 1.0); }',
      transparent: false
    });
    this.points = new THREE.Points(geo, mat); this.points.frustumCulled = false; this.points.renderOrder = 3; scene.add(this.points);
    this.geo = geo; this.world = null;
  }
  Particles.prototype.spawn = function (x, y, z, vx, vy, vz, layer, u, v, size, life, grav, r, g, b, kind) {
    if (this.n >= this.max) return; var i = this.n++;
    this.pos[i * 3] = x; this.pos[i * 3 + 1] = y; this.pos[i * 3 + 2] = z; this.vel[i * 3] = vx; this.vel[i * 3 + 1] = vy; this.vel[i * 3 + 2] = vz;
    this.layer[i] = layer; this.uvo[i * 2] = u; this.uvo[i * 2 + 1] = v; this.size[i] = size; this.life[i] = life; this.maxLife[i] = life; this.grav[i] = grav; this.col[i * 3] = r; this.col[i * 3 + 1] = g; this.col[i * 3 + 2] = b; this.kind[i] = kind || 0;
  };
  // Shared tint resolution for block particles.
  Particles.prototype.blockTint = function (B, x, z) {
    if (B.tint === 'grass' || B.tint === 'foliage') { var g = this.world ? this.world.getBiome(Math.floor(x), Math.floor(z))[B.tint] : MC.BIOMES[1][B.tint]; return [g[0] / 255, g[1] / 255, g[2] / 255]; }
    if (MC.STATIC_TINT[B.tint]) { var s = MC.STATIC_TINT[B.tint]; return [s[0] / 255, s[1] / 255, s[2] / 255]; }
    return [1, 1, 1];
  };
  Particles.prototype.blockBreak = function (x, y, z, id, count) {
    var B = MC.BLOCKS[id]; if (!B || id === 0) return;
    var layer = MC.Tex.layer(B.faces[0]); var tint = this.blockTint(B, x, z);
    if (B.sideOverlay) { layer = MC.Tex.layer('dirt'); tint = [1, 1, 1]; }
    var br = this.world ? this.world.brightnessAt(x, y, z, this.dayLight || 1) : 1;
    count = count || 24;
    for (var i = 0; i < count; i++) {
      var px = x + Math.random(), py = y + Math.random(), pz = z + Math.random();
      var vx = (px - x - 0.5) * 4 + (Math.random() - 0.5), vy = Math.random() * 3 + 1, vz = (pz - z - 0.5) * 4 + (Math.random() - 0.5);
      this.spawn(px, py, pz, vx, vy, vz, layer, Math.floor(Math.random() * 4) * 0.1875, Math.floor(Math.random() * 4) * 0.1875, 0.1 + Math.random() * 0.08, 0.6 + Math.random() * 0.8, 20, tint[0] * br, tint[1] * br, tint[2] * br, 1);
    }
  };
  Particles.prototype.blockHit = function (x, y, z, face, id) {
    var B = MC.BLOCKS[id]; if (!B || id === 0) return;
    var layer = MC.Tex.layer(B.faces[0]); var tint = this.blockTint(B, x, z);
    if (B.sideOverlay) { layer = MC.Tex.layer('dirt'); tint = [1, 1, 1]; }
    var br = this.world ? this.world.brightnessAt(x, y, z, this.dayLight || 1) : 1;
    var px = x + 0.5 + face[0] * 0.55 + (face[0] ? 0 : (Math.random() - 0.5) * 0.8), py = y + 0.5 + face[1] * 0.55 + (face[1] ? 0 : (Math.random() - 0.5) * 0.8), pz = z + 0.5 + face[2] * 0.55 + (face[2] ? 0 : (Math.random() - 0.5) * 0.8);
    this.spawn(px, py, pz, face[0] * 2 + (Math.random() - 0.5), face[1] * 2 + Math.random() * 1.5, face[2] * 2 + (Math.random() - 0.5), layer, Math.floor(Math.random() * 4) * 0.1875, Math.floor(Math.random() * 4) * 0.1875, 0.08, 0.5 + Math.random() * 0.4, 20, tint[0] * br, tint[1] * br, tint[2] * br, 1);
  };
  Particles.prototype.explosion = function (x, y, z, power) {
    for (var i = 0; i < 60; i++) { var d = Math.random() * power; var a = Math.random() * Math.PI * 2, b = Math.random() * Math.PI - Math.PI / 2; var dx = Math.cos(a) * Math.cos(b), dy = Math.sin(b), dz = Math.sin(a) * Math.cos(b); var g = 0.3 + Math.random() * 0.5; this.spawn(x + dx * d, y + dy * d, z + dz * d, dx * 3, dy * 3 + 1, dz * 3, -1, 0, 0, 0.5 + Math.random() * 0.6, 0.8 + Math.random() * 1.2, 1.5, g, g, g, 2); }
    for (i = 0; i < 30; i++) { var a2 = Math.random() * Math.PI * 2; this.spawn(x, y, z, Math.cos(a2) * (2 + Math.random() * 6), Math.random() * 6, Math.sin(a2) * (2 + Math.random() * 6), -1, 0, 0, 0.3, 0.5 + Math.random(), 6, 1, 1, 1, 2); }
  };
  Particles.prototype.smoke = function (x, y, z, n) { for (var i = 0; i < (n || 4); i++) { var g = 0.25 + Math.random() * 0.3; this.spawn(x + (Math.random() - 0.5) * 0.4, y, z + (Math.random() - 0.5) * 0.4, (Math.random() - 0.5) * 0.4, 0.8 + Math.random(), (Math.random() - 0.5) * 0.4, -1, 0, 0, 0.2 + Math.random() * 0.15, 1 + Math.random(), -0.5, g, g, g, 2); } };
  Particles.prototype.flame = function (x, y, z) { this.spawn(x, y, z, (Math.random() - 0.5) * 0.2, 0.3 + Math.random() * 0.3, (Math.random() - 0.5) * 0.2, -1, 0, 0, 0.12, 0.6 + Math.random() * 0.4, 0, 1, 0.75 + Math.random() * 0.25, 0.2, 2); };
  Particles.prototype.heart = function (x, y, z) { this.spawn(x, y, z, (Math.random() - 0.5), 1 + Math.random(), (Math.random() - 0.5), -1, 0, 0, 0.25, 1.2, -0.3, 1, 0.2, 0.3, 2); };
  Particles.prototype.splash = function (x, y, z, n) { for (var i = 0; i < n; i++) this.spawn(x + (Math.random() - 0.5), y, z + (Math.random() - 0.5), (Math.random() - 0.5) * 2, 2 + Math.random() * 3, (Math.random() - 0.5) * 2, -1, 0, 0, 0.12, 0.5 + Math.random() * 0.5, 16, 0.5, 0.7, 1, 2); };
  Particles.prototype.update = function (dt, world) {
    this.world = world;
    var pos = this.pos, vel = this.vel;
    for (var i = 0; i < this.n; i++) {
      this.life[i] -= dt;
      if (this.life[i] <= 0) { var last = --this.n; if (i !== last) this.copy(last, i); i--; continue; }
      var vi = i * 3;
      vel[vi + 1] -= this.grav[i] * dt;
      if (this.kind[i] === 1 && world) { // block fragments collide with ground
        var nx = pos[vi] + vel[vi] * dt, ny = pos[vi + 1] + vel[vi + 1] * dt, nz = pos[vi + 2] + vel[vi + 2] * dt;
        var id = world.getBlock(Math.floor(nx), Math.floor(ny), Math.floor(nz));
        if (id > 0 && MC.BLOCKS[id].solid) {
          var vId = world.getBlock(Math.floor(pos[vi]), Math.floor(ny), Math.floor(pos[vi + 2]));
          if (vId > 0 && MC.BLOCKS[vId].solid) { vel[vi + 1] = 0; ny = pos[vi + 1]; }
          vel[vi] *= 0.5; vel[vi + 2] *= 0.5; nx = pos[vi]; nz = pos[vi + 2];
        }
        pos[vi] = nx; pos[vi + 1] = ny; pos[vi + 2] = nz;
        vel[vi] *= Math.pow(0.02, dt); vel[vi + 2] *= Math.pow(0.02, dt);
      } else {
        pos[vi] += vel[vi] * dt; pos[vi + 1] += vel[vi + 1] * dt; pos[vi + 2] += vel[vi + 2] * dt;
        vel[vi] *= Math.pow(0.1, dt); vel[vi + 2] *= Math.pow(0.1, dt); if (this.kind[i] === 2) vel[vi + 1] *= Math.pow(0.3, dt);
      }
    }
    var a = this.geo.attributes;
    markRange(a.position, this.n); markRange(a.aUV, this.n); markRange(a.aLayer, this.n); markRange(a.aSize, this.n); markRange(a.aCol, this.n);
    this.geo.setDrawRange(0, this.n);
  };
  Particles.prototype.copy = function (from, to) {
    for (var k = 0; k < 3; k++) { this.pos[to * 3 + k] = this.pos[from * 3 + k]; this.vel[to * 3 + k] = this.vel[from * 3 + k]; this.col[to * 3 + k] = this.col[from * 3 + k]; }
    this.uvo[to * 2] = this.uvo[from * 2]; this.uvo[to * 2 + 1] = this.uvo[from * 2 + 1]; this.layer[to] = this.layer[from]; this.size[to] = this.size[from]; this.life[to] = this.life[from]; this.maxLife[to] = this.maxLife[from]; this.grav[to] = this.grav[from]; this.kind[to] = this.kind[from];
  };
  Particles.prototype.clear = function () { this.n = 0; this.geo.setDrawRange(0, 0); };

  MC.BlockMesh = { geometry: blockGeometry, mesh: blockMesh, materialFor: blockMaterialFor, ownLightMaterial: ownLightMaterial };
  MC.ItemMesh = { build: itemMesh, geometry: itemGeometry, texture: itemTexture, stackMesh: stackMesh };
  MC.Entities = Entities; MC.ItemDrop = ItemDrop; MC.XPOrb = XPOrb; MC.FallingBlock = FallingBlock; MC.PrimedTNT = PrimedTNT; MC.ParticlesClass = Particles;
})();

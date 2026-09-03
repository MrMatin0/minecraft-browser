// Main-thread world: mirrors chunk data from the worker, owns chunk meshes, block queries, raycasts.
(function () {
  var H = 128;
  function idx(x, y, z) { return (((x << 4) | z) << 7) | y; }

  var FULL = [[0, 0, 0, 1, 1, 1]];
  // Per-block-id box tables. Previously every raycast step and every collision query
  // re-ran a chain of string comparisons against b.model; raycast alone walks up to 200
  // voxels per frame. Built once, lazily, after MC.BLOCKS exists.
  var hitTable = null, collideTable = null;
  function hitBoxesFor(b) {
    if (!b) return null;
    switch (b.model) {
      case 'liquid': return null;
      case 'cross': return [[0.1, 0, 0.1, 0.9, 0.8, 0.9]];
      case 'torch': return [[0.4, 0, 0.4, 0.6, 0.6, 0.6]];
      case 'lantern': return [[5 / 16, 0, 5 / 16, 11 / 16, 9 / 16, 11 / 16]];
      case 'layer': return [[0, 0, 0, 1, 2 / 16, 1]];
      case 'petals': return [[0, 0, 0, 1, 1 / 16, 1]];
      case 'cactus': return [[1 / 16, 0, 1 / 16, 15 / 16, 1, 15 / 16]];
      default: return FULL;
    }
  }
  function collideBoxesFor(b) {
    if (!b || !b.solid) return null;
    if (b.model === 'cactus') return [[1 / 16, 0, 1 / 16, 15 / 16, 1, 15 / 16]];
    return FULL;
  }
  function buildBoxTables() {
    var B = MC.BLOCKS, n = B.length;
    hitTable = new Array(n); collideTable = new Array(n);
    for (var id = 0; id < n; id++) {
      hitTable[id] = id === 0 ? null : hitBoxesFor(B[id]);
      collideTable[id] = collideBoxesFor(B[id]);
    }
  }

  function World(scene, opts) {
    this.scene = scene; this.seed = opts.seed | 0; this.renderDistance = opts.renderDistance || 8;
    this.forceBiome = opts.forceBiome || null;
    this.chunks = new Map(); this.worker = null; this.materials = null;
    this.center = { cx: NaN, cz: NaN };
    this.events = new MC.Emitter();
    this.pendingMesh = 0; this.pendingGen = 0; this.totalTarget = 1;
    this.meshCount = 0; this.edits = 0; this.timeUniform = 0;
    this.group = new THREE.Group(); scene.add(this.group);
    this.BLOCKS = MC.BLOCKS;
    if (!hitTable) buildBoxTables();
  }
  World.prototype.init = function (texArray) {
    this.materials = MC.Shaders.createChunkMaterials(texArray);
    var src = 'var ns = {};\n' + MC.Shared.map(function (f) { return '(' + f.toString() + ')(ns);'; }).join('\n') + '\n(' + MC.WorkerSource.toString() + ')(ns);';
    var blob = new Blob([src], { type: 'application/javascript' });
    this.worker = new Worker(URL.createObjectURL(blob));
    var self = this;
    this.worker.onmessage = function (e) { self.onMessage(e.data); };
    this.worker.onerror = function (e) { console.error('worker error', e.message, e.filename, e.lineno); };
    // Single init message. This used to be posted here *and* again by the caller when a
    // forceBiome was needed, which re-seeded the worker mid-flight.
    this.worker.postMessage({ type: 'init', seed: this.seed, texIndex: MC.Tex.indexMap(), frames: MC.Tex.FRAMES, forceBiome: this.forceBiome });
  };
  World.prototype.key = function (cx, cz) { return cx + ',' + cz; };
  World.prototype.onMessage = function (m) {
    var k, c;
    switch (m.type) {
      case 'chunk': {
        k = this.key(m.cx, m.cz); c = this.chunks.get(k);
        if (!c) { c = { cx: m.cx, cz: m.cz, meshes: {}, light: null }; this.chunks.set(k, c); }
        c.blocks = new Uint8Array(m.blocks); c.meta = new Uint8Array(m.meta); c.heights = new Uint8Array(m.heights); c.biomes = new Uint8Array(m.biomes); c.topSolid = new Uint8Array(m.topSolid);
        this.events.emit('chunk', c);
        break;
      }
      case 'mesh': {
        k = this.key(m.cx, m.cz); c = this.chunks.get(k); if (!c) return;
        c.light = new Uint8Array(m.light);
        this.applyMesh(c, m.parts);
        this.events.emit('mesh', c);
        break;
      }
      case 'unload': {
        k = this.key(m.cx, m.cz); c = this.chunks.get(k); if (!c) return;
        this.disposeMeshes(c); this.chunks.delete(k); break;
      }
      case 'progress': this.pendingMesh = m.pending; this.pendingGen = m.gen; this.workerStats = m.stats; break;
      case 'blockChanged': {
        for (var i = 0; i < m.list.length; i += 5) {
          var x = m.list[i], y = m.list[i + 1], z = m.list[i + 2], id = m.list[i + 3], meta = m.list[i + 4];
          c = this.chunks.get(this.key(x >> 4, z >> 4)); if (!c || !c.blocks) continue;
          var bi = idx(x & 15, y, z & 15); var old = c.blocks[bi]; c.blocks[bi] = id; c.meta[bi] = meta;
          this.events.emit('blockChanged', { x: x, y: y, z: z, old: old, id: id });
        }
        break;
      }
    }
  };
  World.prototype.disposeMeshes = function (c) {
    for (var k in c.meshes) { var mesh = c.meshes[k]; if (mesh) { this.group.remove(mesh); mesh.geometry.dispose(); } }
    c.meshes = {};
  };
  var MESH_PARTS = ['opaque', 'cutout', 'water'];
  World.prototype.applyMesh = function (c, parts) {
    var wasMeshed = !!c.meshed;
    this.disposeMeshes(c);
    var mats = this.materials;
    var box = new THREE.Box3(new THREE.Vector3(c.cx * 16, 0, c.cz * 16), new THREE.Vector3(c.cx * 16 + 16, H, c.cz * 16 + 16));
    var sphere = new THREE.Sphere(); box.getBoundingSphere(sphere);
    for (var i = 0; i < MESH_PARTS.length; i++) {
      var name = MESH_PARTS[i];
      var p = parts[name]; if (!p) continue;
      var geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(p.pos, 3));
      geo.setAttribute('uv', new THREE.BufferAttribute(p.uv, 2));
      geo.setAttribute('aData', new THREE.BufferAttribute(p.data, 4));
      geo.setAttribute('aColor', new THREE.BufferAttribute(p.col, 4));
      geo.setIndex(new THREE.BufferAttribute(p.idx, 1));
      geo.boundingBox = box; geo.boundingSphere = sphere;
      var mesh = new THREE.Mesh(geo, mats[name]); mesh.matrixAutoUpdate = false; mesh.renderOrder = i; mesh.frustumCulled = true;
      mesh.userData.chunk = c;
      this.group.add(mesh); c.meshes[name] = mesh;
    }
    c.meshed = true; if (!wasMeshed) this.meshCount++;
  };
  World.prototype.setCenter = function (cx, cz, force) {
    if (!force && cx === this.center.cx && cz === this.center.cz) return;
    this.center.cx = cx; this.center.cz = cz;
    var R = this.renderDistance; this.totalTarget = (2 * R + 1) * (2 * R + 1);
    this.worker.postMessage({ type: 'center', cx: cx, cz: cz, r: R });
  };
  World.prototype.setRenderDistance = function (r) { this.renderDistance = r; this.setCenter(this.center.cx, this.center.cz, true); };
  World.prototype.updateUniforms = function (time, camPos) {
    var u = this.materials.uniforms; u.uTime.value = time; u.uCamPos.value.copy(camPos);
    var R = this.renderDistance * 16; u.uFogNear.value = Math.max(8, R * 0.72); u.uFogFar.value = R * 0.98;
  };
  World.prototype.setFog = function (near, far) { this.materials.uniforms.uFogNear.value = near; this.materials.uniforms.uFogFar.value = far; };
  // fraction of chunks within radius r that are meshed (for the loading screen / spawn)
  World.prototype.readyFraction = function (r) {
    var n = 0, tot = 0;
    for (var dx = -r; dx <= r; dx++) for (var dz = -r; dz <= r; dz++) { tot++; var c = this.chunks.get(this.key(this.center.cx + dx, this.center.cz + dz)); if (c && c.meshed) n++; }
    return tot ? n / tot : 0;
  };
  World.prototype.chunkAt = function (x, z) { return this.chunks.get(this.key(x >> 4, z >> 4)); };
  World.prototype.getBlock = function (x, y, z) {
    if (y < 0) return MC.BLOCK.bedrock.id; if (y >= H) return 0;
    var c = this.chunks.get(this.key(x >> 4, z >> 4)); if (!c || !c.blocks) return -1;
    return c.blocks[idx(x & 15, y, z & 15)];
  };
  World.prototype.getBlockDef = function (x, y, z) { var id = this.getBlock(x, y, z); return id < 0 ? null : MC.BLOCKS[id]; };
  World.prototype.getMeta = function (x, y, z) { var c = this.chunks.get(this.key(x >> 4, z >> 4)); if (!c || !c.meta || y < 0 || y >= H) return 0; return c.meta[idx(x & 15, y, z & 15)]; };
  World.prototype.isLoaded = function (x, z) { var c = this.chunks.get(this.key(x >> 4, z >> 4)); return !!(c && c.blocks); };
  World.prototype.setBlock = function (x, y, z, id, meta) {
    if (y < 0 || y >= H) return -1;
    var c = this.chunks.get(this.key(x >> 4, z >> 4)); if (!c || !c.blocks) return -1;
    var i = idx(x & 15, y, z & 15); var old = c.blocks[i];
    c.blocks[i] = id; c.meta[i] = meta || 0;
    var ci = (x & 15) * 16 + (z & 15);
    if (MC.BLOCKS[id].solid && y > c.topSolid[ci]) c.topSolid[ci] = y;
    else if (!MC.BLOCKS[id].solid && y === c.topSolid[ci]) { var yy = y - 1; while (yy > 0 && !MC.BLOCKS[c.blocks[(ci << 7) + yy]].solid) yy--; c.topSolid[ci] = yy; }
    this.worker.postMessage({ type: 'setBlock', x: x, y: y, z: z, id: id, meta: meta || 0 });
    this.edits++;
    this.events.emit('blockChanged', { x: x, y: y, z: z, old: old, id: id });
    return old;
  };
  World.prototype.setBlocks = function (list) { // [x,y,z,id,meta,...]
    var send = [];
    for (var k = 0; k < list.length; k += 5) {
      var x = list[k], y = list[k + 1], z = list[k + 2], id = list[k + 3], meta = list[k + 4];
      var c = this.chunks.get(this.key(x >> 4, z >> 4)); if (!c || !c.blocks || y < 0 || y >= H) continue;
      var i = idx(x & 15, y, z & 15); var old = c.blocks[i]; c.blocks[i] = id; c.meta[i] = meta;
      send.push(x, y, z, id, meta); this.events.emit('blockChanged', { x: x, y: y, z: z, old: old, id: id });
    }
    if (send.length) this.worker.postMessage({ type: 'setBlocks', list: send });
    this.edits++;
  };
  // Packed light: (sky << 4) | block. Use this in hot loops to avoid the object alloc.
  World.prototype.getLightPacked = function (x, y, z) {
    if (y >= H) return 15 << 4; if (y < 0) return 0;
    var c = this.chunks.get(this.key(x >> 4, z >> 4)); if (!c || !c.light) return 15 << 4;
    return c.light[idx(x & 15, y, z & 15)];
  };
  World.prototype.getLight = function (x, y, z) { var v = this.getLightPacked(x, y, z); return { sky: v >> 4, block: v & 15 }; };
  function lightCurve(v) { var f = v / 15; return f / (4 - 3 * f); }
  // brightness 0..1 at position (for entities)
  World.prototype.brightnessAt = function (x, y, z, dayLight) {
    var v = this.getLightPacked(Math.floor(x), Math.floor(y), Math.floor(z));
    return Math.max(0.035, Math.max(lightCurve(v >> 4) * dayLight, lightCurve(v & 15)));
  };
  World.prototype.getBiome = function (x, z) { var c = this.chunks.get(this.key(x >> 4, z >> 4)); if (!c || !c.biomes) return MC.BIOMES[1]; return MC.BIOMES[c.biomes[(x & 15) * 16 + (z & 15)]]; };
  World.prototype.getTopSolid = function (x, z) { var c = this.chunks.get(this.key(x >> 4, z >> 4)); if (!c || !c.topSolid) return -1; return c.topSolid[(x & 15) * 16 + (z & 15)]; };
  World.prototype.getHeight = function (x, z) { var c = this.chunks.get(this.key(x >> 4, z >> 4)); if (!c || !c.heights) return 64; return c.heights[(x & 15) * 16 + (z & 15)]; };

  // Collision boxes for a block (list of [x0,y0,z0,x1,y1,z1] in block-local coords)
  World.prototype.blockBoxes = function (id) { return id > 0 ? collideTable[id] : null; };
  // Selection/hit boxes (for raycast), includes non-solid targetable blocks
  World.prototype.hitBoxes = function (id) { return id > 0 ? hitTable[id] : null; };

  // ---- allocation-free slab test -------------------------------------------------
  // Results land in these module scalars instead of a fresh {t, face} object + arrays.
  var rbT = 0, rbFX = 0, rbFY = 0, rbFZ = 0;
  function rayBox(ox, oy, oz, dx, dy, dz, x0, y0, z0, x1, y1, z1) {
    var tmin = -Infinity, tmax = Infinity;
    var fx = 0, fy = 0, fz = 0, t1, t2, sign, tmp;
    if (dx > -1e-9 && dx < 1e-9) { if (ox < x0 || ox > x1) return false; }
    else {
      t1 = (x0 - ox) / dx; t2 = (x1 - ox) / dx; sign = -1;
      if (t1 > t2) { tmp = t1; t1 = t2; t2 = tmp; sign = 1; }
      if (t1 > tmin) { tmin = t1; fx = sign; fy = 0; fz = 0; }
      if (t2 < tmax) tmax = t2;
      if (tmin > tmax) return false;
    }
    if (dy > -1e-9 && dy < 1e-9) { if (oy < y0 || oy > y1) return false; }
    else {
      t1 = (y0 - oy) / dy; t2 = (y1 - oy) / dy; sign = -1;
      if (t1 > t2) { tmp = t1; t1 = t2; t2 = tmp; sign = 1; }
      if (t1 > tmin) { tmin = t1; fx = 0; fy = sign; fz = 0; }
      if (t2 < tmax) tmax = t2;
      if (tmin > tmax) return false;
    }
    if (dz > -1e-9 && dz < 1e-9) { if (oz < z0 || oz > z1) return false; }
    else {
      t1 = (z0 - oz) / dz; t2 = (z1 - oz) / dz; sign = -1;
      if (t1 > t2) { tmp = t1; t1 = t2; t2 = tmp; sign = 1; }
      if (t1 > tmin) { tmin = t1; fx = 0; fy = 0; fz = sign; }
      if (t2 < tmax) tmax = t2;
      if (tmin > tmax) return false;
    }
    if (tmax < 0) return false;
    if (tmin < 0) { rbT = 0; if (!fx && !fy && !fz) { rbFX = 0; rbFY = 1; rbFZ = 0; } else { rbFX = fx; rbFY = fy; rbFZ = fz; } return true; }
    rbT = tmin; rbFX = fx; rbFY = fy; rbFZ = fz; return true;
  }

  // Amanatides-Woo voxel traversal. Returns {x,y,z,id,face,dist,point} or null.
  World.prototype.raycast = function (origin, dir, maxDist, includeFluids) {
    var ox = origin.x, oy = origin.y, oz = origin.z; var dx = dir.x, dy = dir.y, dz = dir.z;
    var x = Math.floor(ox), y = Math.floor(oy), z = Math.floor(oz);
    var stepX = dx > 0 ? 1 : -1, stepY = dy > 0 ? 1 : -1, stepZ = dz > 0 ? 1 : -1;
    var tDX = dx !== 0 ? Math.abs(1 / dx) : Infinity, tDY = dy !== 0 ? Math.abs(1 / dy) : Infinity, tDZ = dz !== 0 ? Math.abs(1 / dz) : Infinity;
    var tMX = dx !== 0 ? ((dx > 0 ? (x + 1 - ox) : (ox - x)) * tDX) : Infinity, tMY = dy !== 0 ? ((dy > 0 ? (y + 1 - oy) : (oy - y)) * tDY) : Infinity, tMZ = dz !== 0 ? ((dz > 0 ? (z + 1 - oz) : (oz - z)) * tDZ) : Infinity;
    var t = 0;
    for (var n = 0; n < 200; n++) {
      var id = this.getBlock(x, y, z);
      if (id > 0) {
        var boxes = (includeFluids && MC.BLOCKS[id].model === 'liquid') ? FULL : hitTable[id];
        if (boxes) {
          var bestT = Infinity, bfx = 0, bfy = 0, bfz = 0;
          for (var i = 0; i < boxes.length; i++) {
            var bx = boxes[i];
            if (rayBox(ox, oy, oz, dx, dy, dz, x + bx[0], y + bx[1], z + bx[2], x + bx[3], y + bx[4], z + bx[5]) && rbT <= maxDist && rbT < bestT) { bestT = rbT; bfx = rbFX; bfy = rbFY; bfz = rbFZ; }
          }
          if (bestT < Infinity) return { x: x, y: y, z: z, id: id, face: [bfx, bfy, bfz], dist: bestT, point: new THREE.Vector3(ox + dx * bestT, oy + dy * bestT, oz + dz * bestT) };
        }
      }
      if (tMX < tMY) { if (tMX < tMZ) { x += stepX; t = tMX; tMX += tDX; } else { z += stepZ; t = tMZ; tMZ += tDZ; } }
      else { if (tMY < tMZ) { y += stepY; t = tMY; tMY += tDY; } else { z += stepZ; t = tMZ; tMZ += tDZ; } }
      if (t > maxDist) return null;
      if (y < 0 || y >= H) return null;
    }
    return null;
  };

  // AABB collision helpers.
  // `out` is the caller's persistent scratch array; the box arrays inside it are recycled
  // across calls (out[i] is always the same object) so this no longer allocates per block.
  World.prototype.collectBoxes = function (minX, minY, minZ, maxX, maxY, maxZ, out) {
    var pool = out.pool || (out.pool = []);
    var n = 0, a;
    var x0 = Math.floor(minX), x1 = Math.floor(maxX), y0 = Math.max(0, Math.floor(minY)), y1 = Math.min(H - 1, Math.floor(maxY)), z0 = Math.floor(minZ), z1 = Math.floor(maxZ);
    for (var x = x0; x <= x1; x++) for (var z = z0; z <= z1; z++) for (var y = y0; y <= y1; y++) {
      var id = this.getBlock(x, y, z);
      if (id === 0) continue;
      if (id === -1) { // unloaded: treat as solid so entities never fall through
        a = pool[n] || (pool[n] = new Array(6));
        a[0] = x; a[1] = y; a[2] = z; a[3] = x + 1; a[4] = y + 1; a[5] = z + 1;
        out[n++] = a; continue;
      }
      var boxes = collideTable[id]; if (!boxes) continue;
      for (var i = 0; i < boxes.length; i++) {
        var b = boxes[i];
        a = pool[n] || (pool[n] = new Array(6));
        a[0] = x + b[0]; a[1] = y + b[1]; a[2] = z + b[2]; a[3] = x + b[3]; a[4] = y + b[4]; a[5] = z + b[5];
        out[n++] = a;
      }
    }
    if (minY < 0) { a = pool[n] || (pool[n] = new Array(6)); a[0] = x0; a[1] = -1; a[2] = z0; a[3] = x1 + 1; a[4] = 0; a[5] = z1 + 1; out[n++] = a; }
    out.length = n;
    return out;
  };
  World.prototype.dispose = function () {
    if (this.worker) this.worker.terminate();
    var self = this; this.chunks.forEach(function (c) { self.disposeMeshes(c); }); this.chunks.clear();
    this.scene.remove(this.group);
  };
  var SPAWN_SURFACES = { grass_block: 1, sand: 1, snowy_grass_block: 1, podzol: 1, dirt: 1 };
  World.prototype.findSpawn = function () {
    // search near origin for a flat, sky-exposed grass/sand column above sea level
    var best = null, bestScore = -Infinity;
    for (var r = 0; r < 80; r += 2) for (var a = 0; a < 24; a++) {
      var x = Math.round(Math.cos(a / 24 * Math.PI * 2) * r), z = Math.round(Math.sin(a / 24 * Math.PI * 2) * r);
      if (!this.isLoaded(x, z)) continue;
      var y = this.getTopSolid(x, z); if (y <= 62) continue;
      var id = this.getBlock(x, y, z); var b = MC.BLOCKS[id];
      if (!b || !SPAWN_SURFACES[b.name]) continue;
      if (this.getBlock(x, y + 1, z) !== 0 || this.getBlock(x, y + 2, z) !== 0) continue;
      var maxD = 0, n = 0;
      for (var dx = -4; dx <= 4; dx += 2) for (var dz = -4; dz <= 4; dz += 2) { if (!this.isLoaded(x + dx, z + dz)) continue; var ty = this.getTopSolid(x + dx, z + dz); maxD = Math.max(maxD, Math.abs(ty - y)); n++; }
      if (n < 20) continue;
      var here = new THREE.Vector3(x + 0.5, y + 1, z + 0.5);
      // Perfectly flat grass is good enough -- take it immediately. (This used to return
      // `best`, i.e. some *other* candidate, and returned null when nothing had scored yet.)
      if (maxD <= 1 && b.name === 'grass_block') return here;
      var score = -maxD * 3 - r * 0.05 + (b.name === 'grass_block' ? 4 : 0);
      if (score > bestScore) { bestScore = score; best = here; }
    }
    if (best) return best;
    return new THREE.Vector3(0.5, Math.max(64, this.getTopSolid(0, 0) + 1), 0.5);
  };
  MC.World = World; MC.WORLD_HEIGHT = H;
})();

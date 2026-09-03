// Game orchestration: renderer, states (title / loading / playing), screens, saving, hand rendering, block outline.
(function () {
  var DEFAULT_OPTIONS = { fov: 70, renderDistance: 8, sensitivity: 0.5, invertMouse: false, bobbing: true, clouds: true, fancy: true, guiScale: 0, maxFps: 260, gamma: 0.5, autoJump: false, damageTilt: 1, volumes: { master: 1, music: 1, blocks: 1, hostile: 1, friendly: 1, players: 1, ambient: 1, ui: 1 } };
  MC.Options = Object.assign({}, DEFAULT_OPTIONS, MC.Storage.get('options', {}));
  MC.Options.volumes = Object.assign({}, DEFAULT_OPTIONS.volumes, MC.Options.volumes || {});
  MC.saveOptions = function () { MC.Storage.set('options', MC.Options); };

  // Per-frame scratch. The render / hand paths run 60-260 times a second.
  var _right = new THREE.Vector3(), _armDir = new THREE.Vector3(), _armNear = new THREE.Vector3(), _up = new THREE.Vector3(0, 1, 0), _negDir = new THREE.Vector3();
  var _vpos = new THREE.Vector3(), _vdir = new THREE.Vector3(), _vtmp = new THREE.Vector3();
  var TORCH_NEIGHBOURS = [[1, 0, 0, 1], [-1, 0, 0, 2], [0, 0, 1, 3], [0, 0, -1, 4]];
  var SUPPORTED_MODELS = { cross: 1, layer: 1, petals: 1 };
  var FALLBACK_BOX = [0, 0, 0, 1, 1, 1];
  function lightCurve(v) { var f = v / 15; return f / (4 - 3 * f); }

  function Game() {
    this.state = 'boot'; this.screen = null; this.time = 0; this.last = performance.now(); this.frameAcc = 0;
    this.stats = { chunksRendered: 0 }; this.rendererName = 'WebGL2'; this.difficulty = 'normal'; this.worldInfo = null;
    this.edits = {}; this.editsByChunk = {}; this.containers = {}; this.furnaces = {}; this.saplings = []; this.autosaveT = 0;
    this.shake = 0; this.errorLogT = -10;
  }
  Game.prototype.init = function () {
    var self = this;
    this.canvas = document.getElementById('game'); this.guiCanvas = document.getElementById('gui'); this.crosshair = document.getElementById('crosshair');
    try { this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: false, powerPreference: 'high-performance', alpha: false, stencil: false }); }
    catch (e) { document.body.innerHTML = '<div style=\'color:#fff;font:16px sans-serif;padding:20px\'>WebGL 2 is required to run this game.</div>'; return; }
    this.renderer.autoClear = false; this.renderer.outputColorSpace = THREE.SRGBColorSpace; this.renderer.setPixelRatio(1);
    var gl = this.renderer.getContext(); var dbg = gl.getExtension('WEBGL_debug_renderer_info'); if (dbg) this.rendererName = String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)).slice(0, 40);
    MC.Tex.build(); MC.Sprites.build(); MC.ItemIcons.build();
    this.texArray = MC.Tex.makeArrayTexture();
    MC.IconRenderer.init(this.texArray);
    MC.Gui.init(this.guiCanvas); MC.Input.init(this.canvas);
    MC.Input.onUnlock = function () { if (self.state === 'playing' && !self.screen && !self.chat.open) self.openScreen(new MC.Screens.PauseScreen(self)); };
    this.camera = new THREE.PerspectiveCamera(70, 1, 0.05, 1000);
    this.handCamera = new THREE.PerspectiveCamera(70, 1, 0.01, 10);
    this.chat = new MC.Chat(this);
    window.addEventListener('resize', function () { self.resize(); });
    document.addEventListener('visibilitychange', function () { if (document.hidden && self.state === 'playing') self.saveWorld(); });
    window.addEventListener('beforeunload', function () { if (self.state === 'playing') self.saveWorld(); });
    document.addEventListener('mousedown', function () { MC.Audio.init(); MC.Audio.resume(); if (self.state === 'title' && !self.musicStarted) { self.musicStarted = true; MC.Audio.setMusicMode('menu'); } });
    this.resize();
    this.buildHandScene();
    this.setupPanorama();
    this.openScreen(new MC.Screens.TitleScreen(this)); this.state = 'title';
    this.applyOptions();
    if (MC.query.autoplay) { var info = this.createWorld({ name: 'Test World', seed: MC.query.seed || '12345', gameMode: MC.query.mode || 'survival', cheats: true, difficulty: 'normal' }); this.startWorld(info); }
    requestAnimationFrame(function (t) { self.frame(t); });
    this.installDebugApi();
  };
  // Console / test harness hooks. Split out of init() so init stays readable.
  Game.prototype.installDebugApi = function () {
    var self = this;
    MC.debug = {
      game: this,
      tp: function (x, y, z) { self.player.pos.set(x, y, z); self.player.prevPos.copy(self.player.pos); },
      time: function (t) { self.sky.time = t; },
      look: function (yaw, pitch) { self.player.yaw = yaw; self.player.pitch = pitch; },
      lock: function () { MC.Input.mouse.locked = true; },
      screen: function () { return self.screen ? self.screen.constructor.name : null; },
      state: function () { return self.state; },
      give: function (id, n) { self.player.inventory.add(id, n || 1, 0); },
      mode: function (m) { self.player.setGameMode(m); },
      open: function (name) { self.openScreen(new (MC.Inventory.Screens[name] || MC.Screens[name])(self)); },
      spawn: function (t, dx, dz) {
        var d = self.player.getLookDir();
        var p = self.player.pos.clone(); p.x += d.x * 5 + (dx || 0); p.z += d.z * 5 + (dz || 0);
        p.y = self.world.getTopSolid(Math.floor(p.x), Math.floor(p.z)) + 1;
        return !!self.spawnMob(t, p);
      },
      ready: function () { return self.state === 'playing'; }
    };
  };
  Game.prototype.resize = function () {
    var w = window.innerWidth, h = window.innerHeight;
    this.renderer.setSize(w, h, false); this.camera.aspect = w / h; this.camera.updateProjectionMatrix(); this.handCamera.aspect = w / h; this.handCamera.updateProjectionMatrix();
    MC.Gui.forcedScale = MC.Options.guiScale || 0; MC.Gui.resize(w, h);
    if (this.screen) this.screen.layout();
    this.updateCrosshair();
    if (this.pano) { this.pano.camera.aspect = w / h; this.pano.camera.updateProjectionMatrix(); }
  };
  Game.prototype.updateCrosshair = function () {
    var S = MC.Gui.S; var c = this.crosshair; c.width = 15 * S; c.height = 15 * S; var x = c.getContext('2d'); x.imageSmoothingEnabled = false; x.drawImage(MC.Sprites.s.crosshair, 0, 0, 15 * S, 15 * S);
    c.style.width = (15 * S) + 'px'; c.style.height = (15 * S) + 'px';
  };
  Game.prototype.applyOptions = function () {
    var O = MC.Options;
    Object.keys(O.volumes).forEach(function (k) { MC.Audio.setVolume(k, O.volumes[k]); });
    if (this.world && this.world.renderDistance !== O.renderDistance) this.world.setRenderDistance(O.renderDistance);
    if (this.world) this.world.materials.uniforms.uGamma.value = O.gamma;
    if (this.sky) this.sky.cloudsEnabled = O.clouds;
    if (this.player) this.player.autoJump = O.autoJump;
    if (MC.Gui.forcedScale !== (O.guiScale || 0)) this.resize();
    this.camera.far = Math.max(300, O.renderDistance * 16 * 2 + 200); this.camera.updateProjectionMatrix();
  };
  Game.prototype.toggleFullscreen = function () { if (document.fullscreenElement) document.exitFullscreen(); else document.documentElement.requestFullscreen().catch(function () { }); };
  Game.prototype.quit = function () {
    // Browsers refuse window.close() on pages they did not open, so save and explain
    // instead of calling it and then showing the dialog anyway.
    this.saveWorld();
    this.openScreen(new MC.Screens.ConfirmScreen(this, this.screen, 'Quit Game', 'Close this browser tab to quit. (Browsers do not allow pages to close themselves.)', 'OK', function () { }));
  };

  // ---------------- screens ----------------
  Game.prototype.openScreen = function (s) {
    if (this.screen && this.screen !== s) this.screen.onClose();
    this.screen = s; if (s) { s.onOpen(); MC.Input.unlock(); this.crosshair.style.display = 'none'; }
  };
  Game.prototype.closeScreen = function () {
    if (this.screen) this.screen.onClose(); this.screen = null;
    if (this.state === 'playing') { MC.Input.lock(); this.crosshair.style.display = MC.Hud.hidden ? 'none' : 'block'; }
  };
  Game.prototype.drawScreenBackground = function () { if (this.state === 'playing') MC.Gui.drawDim(); else MC.Gui.drawBackground(); };
  Game.prototype.onChatClosed = function () { if (this.state === 'playing' && !this.screen) { MC.Input.lock(); this.player.controlsEnabled = true; } };

  // ---------------- panorama (title background) ----------------
  Game.prototype.setupPanorama = function () {
    var scene = new THREE.Scene();
    // forceBiome goes through the constructor so World.init() posts exactly one init message.
    var world = new MC.World(scene, { seed: 20230725, renderDistance: 5, forceBiome: 'cherry_grove' });
    world.init(this.texArray);
    var sky = new MC.Sky(scene, world.materials.uniforms); sky.time = 12400;
    var camera = new THREE.PerspectiveCamera(85, window.innerWidth / window.innerHeight, 0.05, 1000);
    this.pano = { scene: scene, world: world, sky: sky, camera: camera, angle: 0, ready: false, particles: null };
    world.setCenter(0, 0);
  };
  Game.prototype.disposePanorama = function () { if (!this.pano) return; this.pano.world.dispose(); this.pano = null; };
  Game.prototype.renderPanorama = function (dt) {
    var p = this.pano; if (!p) return;
    p.angle += dt * (Math.PI * 2 / 150);
    if (p.camY === undefined || (!p.ready && p.world.readyFraction(1) >= 1)) { var mh = 0; for (var dx = -6; dx <= 6; dx++) for (var dz = -6; dz <= 6; dz++) mh = Math.max(mh, p.world.getTopSolid(dx, dz)); p.camY = Math.max(mh, 66) + 7; }
    p.camera.position.set(0.5, p.camY, 0.5); p.camera.rotation.order = 'YXZ'; p.camera.rotation.y = -p.angle; p.camera.rotation.x = -0.12;
    p.world.updateUniforms(this.time, p.camera.position);
    var u = p.world.materials.uniforms; u.uFogNear.value = 60; u.uFogFar.value = 90; u.uGamma.value = 0.5;
    p.sky.update(dt, p.camera.position, MC.BIOME.cherry_grove, false, p.camera.far);
    this.renderer.setClearColor(p.sky.fogColor); this.renderer.clear(true, true, false);
    this.renderer.render(p.scene, p.camera);
    if (!p.ready && p.world.readyFraction(2) >= 1) p.ready = true;
  };

  // ---------------- worlds (storage) ----------------
  Game.prototype.listWorlds = function () { var keys = MC.Storage.keys('worldinfo:'); var out = []; for (var i = 0; i < keys.length; i++) { var w = MC.Storage.get(keys[i]); if (w) out.push(w); } out.sort(function (a, b) { return (b.lastPlayed || b.created) - (a.lastPlayed || a.created); }); return out; };
  Game.prototype.createWorld = function (o) {
    var id = o.name.replace(/[^a-zA-Z0-9_ -]/g, '').trim() || 'World'; var base = id, n = 1; var existing = this.listWorlds().map(function (w) { return w.id; });
    while (existing.indexOf(id) >= 0) id = base + ' (' + (++n) + ')';
    var seedStr = MC.formatSeed(o.seed);
    var info = { id: id, name: o.name, seed: seedStr, seedInt: MC.seedToInt(seedStr), gameMode: o.gameMode || 'survival', hardcore: !!o.hardcore, difficulty: o.difficulty || 'normal', cheats: !!o.cheats, created: Date.now(), lastPlayed: Date.now(), time: 1000, version: MC.VERSION };
    MC.Storage.set('worldinfo:' + id, info); return info;
  };
  Game.prototype.saveWorldInfo = function (info) { MC.Storage.set('worldinfo:' + info.id, info); };
  Game.prototype.deleteWorld = function (id) { MC.Storage.del('worldinfo:' + id); MC.Storage.del('worlddata:' + id); };
  Game.prototype.saveWorld = function () {
    if (this.state !== 'playing' || !this.worldInfo) return;
    var info = this.worldInfo; info.lastPlayed = Date.now(); info.time = this.sky.time; info.gameMode = this.player.gameMode;
    this.saveWorldInfo(info);
    var data = { edits: this.edits, player: this.player.serialize(), mobs: MC.Mobs.serialize(), containers: this.containers, furnaces: this.furnaces, saplings: this.saplings, time: this.sky.time, difficulty: this.difficulty };
    try { MC.Storage.set('worlddata:' + info.id, data); } catch (e) { this.chat.add('§cFailed to save world (storage full?)'); }
  };
  Game.prototype.saveAndQuit = function () { this.saveWorld(); this.toTitle(); };
  Game.prototype.toTitle = function () {
    MC.Input.unlock(); this.crosshair.style.display = 'none';
    this.disposeWorldVisuals();
    if (this.world) { this.world.dispose(); this.world = null; }
    if (this.scene) this.scene.clear();
    MC.Mobs.clear(); if (this.entities) this.entities.clear(); if (this.particles) this.particles.clear();
    this.player = null; this.state = 'title'; this.chat.messages = []; this.chat.open = false; MC.Input.setTextTarget(null);
    if (!this.pano) this.setupPanorama();
    MC.Audio.setMusicMode('menu');
    this.openScreen(new MC.Screens.TitleScreen(this));
  };
  // buildSelection() rebuilds these per world. Without disposing, every world load leaked
  // a LineSegments geometry, ten break-stage geometries and two materials.
  Game.prototype.disposeWorldVisuals = function () {
    if (this.selection) { this.selection.geometry.dispose(); this.selection.material.dispose(); this.selection = null; }
    if (this.breakGeos) { for (var i = 0; i < this.breakGeos.length; i++) this.breakGeos[i].dispose(); this.breakGeos = null; }
    if (this.breakMat) { this.breakMat.dispose(); this.breakMat = null; }
    this.breakMesh = null;
    this.clearHeldMesh();
  };

  // ---------------- start / load world ----------------
  Game.prototype.startWorld = function (info) {
    var self = this; this.worldInfo = info; this.difficulty = info.difficulty || 'normal';
    this.openScreen(null); this.state = 'loading'; this.loadT = 0; this.loadStage = 'Building terrain';
    this.disposePanorama();
    this.scene = new THREE.Scene();
    this.world = new MC.World(this.scene, { seed: info.seedInt, renderDistance: MC.Options.renderDistance }); this.world.init(this.texArray);
    this.world.materials.uniforms.uGamma.value = MC.Options.gamma;
    this.sky = new MC.Sky(this.scene, this.world.materials.uniforms); this.sky.time = info.time || 1000; this.sky.cloudsEnabled = MC.Options.clouds;
    this.entities = new MC.Entities(this.world, this.scene, this.world.materials); this.entities.game = this;
    this.particles = new MC.ParticlesClass(this.scene, this.texArray, this.world.materials.uniforms); MC.Particles = this.particles;
    MC.Mobs.init(this.world, this.scene, this.entities, this.world.materials.uniforms, this.sky, this);
    this.player = new MC.Player(this.world, this); this.player.setGameMode(info.gameMode); this.player.autoJump = MC.Options.autoJump;
    MC.Mobs.setPlayer(this.player);
    this.edits = {}; this.editsByChunk = {}; this.containers = {}; this.furnaces = {}; this.saplings = [];
    var data = MC.Storage.get('worlddata:' + info.id, null); this.saveData = data;
    if (data) { this.edits = data.edits || {}; this.containers = data.containers || {}; this.furnaces = data.furnaces || {}; this.saplings = data.saplings || []; if (data.time) this.sky.time = data.time; if (data.difficulty) this.difficulty = data.difficulty; this.indexEdits(); }
    this.world.events.on('chunk', function (c) { self.onChunk(c); });
    this.world.events.on('blockChanged', function (e) { self.onBlockChanged(e); });
    var start = data && data.player ? new THREE.Vector3(data.player.pos[0], data.player.pos[1], data.player.pos[2]) : new THREE.Vector3(0.5, 70, 0.5);
    this.player.pos.copy(start); this.player.prevPos.copy(start);
    this.world.setCenter(Math.floor(start.x) >> 4, Math.floor(start.z) >> 4);
    this.buildSelection();
    MC.Audio.stopMusic();
    this.chat.messages = [];
  };
  Game.prototype.indexEdits = function () { this.editsByChunk = {}; for (var k in this.edits) { var p = k.split(','); var x = +p[0], y = +p[1], z = +p[2]; var ck = (x >> 4) + ',' + (z >> 4); (this.editsByChunk[ck] = this.editsByChunk[ck] || []).push(x, y, z, this.edits[k][0], this.edits[k][1]); } };
  Game.prototype.onChunk = function (c) {
    var list = this.editsByChunk[c.cx + ',' + c.cz]; if (!list) return;
    var send = [];
    for (var i = 0; i < list.length; i += 5) { var x = list[i], y = list[i + 1], z = list[i + 2]; var bi = (((x & 15) << 4 | (z & 15)) << 7) | y; c.blocks[bi] = list[i + 3]; c.meta[bi] = list[i + 4]; send.push(x, y, z, list[i + 3], list[i + 4]); }
    this.world.worker.postMessage({ type: 'setBlocks', list: send });
  };
  Game.prototype.finishLoading = function () {
    var self = this; var data = this.saveData;
    if (data && data.player) { this.player.load(data.player); MC.Mobs.load(data.mobs); }
    else { var sp = this.world.findSpawn(); this.player.pos.copy(sp); this.player.prevPos.copy(sp); this.player.spawn.copy(sp); MC.Mobs.seedSalt = this.worldInfo.seedInt; MC.Mobs.initialSpawn(sp, 10); }
    this.state = 'playing'; this.closeScreen();
    MC.Audio.setMusicMode('game');
    if (!data) this.chat.add('§7Welcome to ' + this.worldInfo.name + '! Press §fE§7 for inventory, §fT§7 to chat, §f/help§7 for commands.');
    this.player.controlsEnabled = true;
    setTimeout(function () { if (self.state === 'playing' && !self.screen) MC.Input.lock(); }, 50);
  };

  // ---------------- world events ----------------
  Game.prototype.recordEdit = function (x, y, z, id, meta) { var k = x + ',' + y + ',' + z; this.edits[k] = [id, meta || 0]; var ck = (x >> 4) + ',' + (z >> 4); var arr = this.editsByChunk[ck] || (this.editsByChunk[ck] = []); arr.push(x, y, z, id, meta || 0); };
  Game.prototype.onBlockChanged = function (e) {
    var world = this.world, i;
    this.recordEdit(e.x, e.y, e.z, e.id, world.getMeta(e.x, e.y, e.z));
    var nowSolid = e.id > 0 && MC.BLOCKS[e.id].solid;
    // gravity blocks above / this one
    var above = world.getBlock(e.x, e.y + 1, e.z);
    if (above > 0 && MC.BLOCKS[above].gravity && !nowSolid) this.scheduleFall(e.x, e.y + 1, e.z);
    if (e.id > 0 && MC.BLOCKS[e.id].gravity) { var below = world.getBlock(e.x, e.y - 1, e.z); if (below === 0 || (below > 0 && !MC.BLOCKS[below].solid)) this.scheduleFall(e.x, e.y, e.z); }
    // plants / snow / petals above lose their support
    if (!nowSolid && above > 0) {
      var A = MC.BLOCKS[above];
      if (SUPPORTED_MODELS[A.model] || (A.model === 'torch' && world.getMeta(e.x, e.y + 1, e.z) === 0)) {
        world.setBlock(e.x, e.y + 1, e.z, 0, 0);
        if (A.drops && !this.player.isCreative()) { var d = this.dropsFor(above, null, true); for (i = 0; i < d.length; i++) this.spawnDrop(d[i], _vpos.set(e.x + 0.5, e.y + 1.3, e.z + 0.5)); }
        MC.Particles.blockBreak(e.x, e.y + 1, e.z, above, 8);
      }
    }
    // wall torches attached to this block
    if (e.id === 0) {
      for (var n = 0; n < 4; n++) {
        var dir = TORCH_NEIGHBOURS[n]; var tx = e.x + dir[0], tz = e.z + dir[2];
        if (world.getBlock(tx, e.y, tz) !== MC.BLOCK.torch.id || world.getMeta(tx, e.y, tz) !== dir[3]) continue;
        world.setBlock(tx, e.y, tz, 0, 0);
        if (!this.player.isCreative()) this.spawnDrop({ id: 'torch', count: 1, damage: 0 }, _vpos.set(tx + 0.5, e.y + 0.3, tz + 0.5));
      }
    }
    // block entities destroyed -> spill contents
    if (e.id !== e.old) {
      var key = e.x + ',' + e.y + ',' + e.z;
      var st = e.old === MC.BLOCK.chest.id ? this.containers[key] : null;
      if (st) { for (i = 0; i < st.slots.length; i++) if (st.slots[i]) this.spawnDrop(st.slots[i], _vpos.set(e.x + 0.5, e.y + 0.5, e.z + 0.5)); delete this.containers[key]; }
      var fs = e.old === MC.BLOCK.furnace.id ? this.furnaces[key] : null;
      if (fs) { for (i = 0; i < 3; i++) if (fs.slots[i]) this.spawnDrop(fs.slots[i], _vpos.set(e.x + 0.5, e.y + 0.5, e.z + 0.5)); delete this.furnaces[key]; }
    }
  };
  Game.prototype.scheduleFall = function (x, y, z) {
    var self = this;
    setTimeout(function () {
      if (self.state !== 'playing') return;
      var id = self.world.getBlock(x, y, z); if (id <= 0 || !MC.BLOCKS[id].gravity) return;
      var below = self.world.getBlock(x, y - 1, z); if (below > 0 && MC.BLOCKS[below].solid) return;
      var meta = self.world.getMeta(x, y, z);
      self.world.setBlock(x, y, z, 0, 0);
      self.entities.add(new MC.FallingBlock(self.entities, id, meta, x, y, z));
    }, 100);
  };
  Game.prototype.onBlockBroken = function (x, y, z, id, meta) { /* hook for future block-entity cleanup */ };
  Game.prototype.onBlockPlaced = function (x, y, z, id) { var B = MC.BLOCKS[id]; if ((/_sapling$/).test(B.name)) this.saplings.push({ x: x, y: y, z: z, t: this.time + 45 + Math.random() * 60, type: B.name.replace('_sapling', '') }); };
  Game.prototype.boneMeal = function (hit) {
    var w = this.world;
    for (var i = 0; i < 12; i++) {
      var x = hit.x + Math.floor(Math.random() * 7) - 3, z = hit.z + Math.floor(Math.random() * 7) - 3, y = w.getTopSolid(x, z) + 1;
      if (w.getBlock(x, y - 1, z) === MC.BLOCK.grass_block.id && w.getBlock(x, y, z) === 0) w.setBlock(x, y, z, Math.random() < 0.85 ? MC.BLOCK.short_grass.id : (Math.random() < 0.5 ? MC.BLOCK.dandelion.id : MC.BLOCK.poppy.id), 0);
    }
    for (i = 0; i < 10; i++) MC.Particles.heart(hit.x + Math.random(), hit.y + 1.2, hit.z + Math.random());
    MC.Audio.play('dig.grass', { pos: hit.point, volume: 0.5 });
  };
  var SHEAR_DROPS_SELF = { glass: 1, ice: 1, glowstone: 1, short_grass: 1, fern: 1, cobweb: 1, seagrass: 1 };
  Game.prototype.dropsFor = function (id, held, canHarvest) {
    var B = MC.BLOCKS[id]; if (!B || B.drops === null) return [];
    if (canHarvest === false) return [];
    var tool = held && MC.ITEMS[held.id] && MC.ITEMS[held.id].tool ? MC.ITEMS[held.id].tool : null;
    var shears = !!(tool && tool.type === 'shears');
    // Shears (or a hoe on leaves) yield the block itself instead of its normal drop table.
    if (shears && (SHEAR_DROPS_SELF[B.name] || (/stained_glass/).test(B.name))) return [{ id: B.name, count: 1, damage: 0 }];
    if ((/leaves/).test(B.name) && (shears || (tool && tool.type === 'hoe'))) return [{ id: B.name, count: 1, damage: 0 }];
    if (typeof B.drops === 'string') return MC.ITEMS[B.drops] ? [{ id: B.drops, count: 1, damage: 0 }] : [];
    var out = [];
    for (var i = 0; i < B.drops.length; i++) {
      var d = B.drops[i];
      if (Math.random() >= d.chance) continue;
      var n = d.min + Math.floor(Math.random() * (d.max - d.min + 1));
      if (n > 0 && MC.ITEMS[d.item]) out.push({ id: d.item, count: n, damage: 0 });
      // `exclusive` entries (and the gravel -> flint roll) end the table early
      if (d.exclusive || (i === 0 && d.chance < 1 && d.item === 'flint')) break;
    }
    return out;
  };
  Game.prototype.spawnDrop = function (stack, pos, vel) { if (!stack || !MC.ITEMS[stack.id]) return; this.entities.add(new MC.ItemDrop(this.entities, { id: stack.id, count: stack.count, damage: stack.damage || 0 }, pos, vel)); };
  Game.prototype.dropItem = function (stack) {
    if (!stack) return; var p = this.player;
    var d = p.getLookDirInto(_vdir);
    var pos = p.getEyePosInto(_vpos, 1); pos.addScaledVector(d, 0.3); pos.y -= 0.3;
    var vel = _vtmp.copy(d).multiplyScalar(6); vel.y += 1; vel.x += (Math.random() - 0.5); vel.z += (Math.random() - 0.5);
    this.entities.add(new MC.ItemDrop(this.entities, stack, pos, vel)).pickupDelay = 2;
  };
  Game.prototype.spawnXP = function (pos, n) { while (n > 0) { var v = Math.min(n, n > 10 ? 7 : 3); this.entities.add(new MC.XPOrb(this.entities, pos, v)); n -= v; } };
  Game.prototype.spawnMob = function (type, pos) { return MC.Mobs.spawn(type, pos); };
  Game.prototype.primeTNT = function (x, y, z) { this.entities.add(new MC.PrimedTNT(this.entities, x, y, z, 4)); };
  Game.prototype.shootArrow = function (mob, player) {
    var from = new THREE.Vector3(mob.pos.x, mob.pos.y + mob.height * 0.85, mob.pos.z);
    var vel = new THREE.Vector3(player.pos.x - from.x, player.pos.y + 1.2 - from.y, player.pos.z - from.z);
    var dist = vel.length() || 1; vel.multiplyScalar(22 / dist);
    vel.y += dist * 0.5 + (Math.random() - 0.5) * 2; vel.x += (Math.random() - 0.5) * 2; vel.z += (Math.random() - 0.5) * 2;
    this.entities.add(new Arrow(this.entities, from, vel));
    MC.Audio.play('bow.shoot', { pos: from });
  };
  Game.prototype.onPlayerDeath = function (source) {
    var inv = this.player.inventory, p = this.player;
    if (!p.isCreative()) {
      for (var i = 0; i < inv.slots.length; i++) {
        if (!inv.slots[i]) continue;
        this.spawnDrop(inv.slots[i], _vpos.set(p.pos.x, p.pos.y + 1, p.pos.z), _vtmp.set((Math.random() - 0.5) * 4, 3, (Math.random() - 0.5) * 4));
        inv.slots[i] = null;
      }
    }
    this.openScreen(new MC.Screens.DeathScreen(this, this.worldInfo.hardcore));
  };
  Game.prototype.respawn = function () {
    var p = this.player;
    p.respawn();
    if (this.worldInfo.hardcore) { p.setGameMode('creative'); p.flying = true; }
    this.closeScreen();
    var list = MC.Mobs.list;
    for (var i = 0; i < list.length; i++) { var m = list[i]; if (m.T.hostile && m.pos.distanceToSquared(p.pos) < 576) m.dead = true; }
  };
  Game.prototype.openCrafting = function () { this.openScreen(new MC.Inventory.Screens.CraftingScreen(this)); };
  Game.prototype.openFurnace = function (hit) { var k = hit.x + ',' + hit.y + ',' + hit.z; var st = this.furnaces[k] || (this.furnaces[k] = { slots: [null, null, null], progress: 0, burn: 0, burnMax: 0 }); this.openScreen(new MC.Inventory.Screens.FurnaceScreen(this, st)); };
  Game.prototype.openChest = function (hit) { var k = hit.x + ',' + hit.y + ',' + hit.z; var st = this.containers[k] || (this.containers[k] = { slots: new Array(27).fill(null) }); this.openScreen(new MC.Inventory.Screens.ChestScreen(this, st)); };
  Game.prototype.onExplosion = function (center, power) { this.shake = 0.6; };

  // ---------------- Arrow projectile ----------------
  // One shared template; every arrow used to build 3 geometries + 3 materials of its own
  // and never disposed them.
  var arrowTemplateMesh = null;
  function arrowTemplate() {
    if (arrowTemplateMesh) return arrowTemplateMesh;
    var shaft = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.05, 0.6), new THREE.MeshBasicMaterial({ color: 0x8a6a3a, fog: false }));
    var tip = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.08, 0.12), new THREE.MeshBasicMaterial({ color: 0xcfcfcf, fog: false })); tip.position.z = -0.3; shaft.add(tip);
    var fl = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.12, 0.15), new THREE.MeshBasicMaterial({ color: 0xeeeeee, fog: false })); fl.position.z = 0.25; shaft.add(fl);
    arrowTemplateMesh = shaft; return shaft;
  }
  function Arrow(ents, pos, vel) {
    this.pos = pos.clone(); this.vel = vel.clone(); this.width = 0.3; this.height = 0.3; this.age = 0; this.dead = false; this.stuck = false; this.onGround = false;
    this.mesh = arrowTemplate().clone(true);
  }
  var _aStep = new THREE.Vector3(), _aDir = new THREE.Vector3(), _aLook = new THREE.Vector3();
  Arrow.prototype.update = function (dt, player, ents) {
    this.age += dt; if (this.age > 20) { this.dead = true; return; }
    if (this.stuck) return;
    this.vel.y -= 20 * dt;
    // Sweep the travel segment. Sampling only the destination block let arrows (0.37 blocks
    // per frame at 22 m/s) pass straight through walls.
    _aStep.copy(this.vel).multiplyScalar(dt);
    var travel = _aStep.length();
    if (travel > 1e-6) {
      _aDir.copy(_aStep).divideScalar(travel);
      var blocked = ents.world.raycast(this.pos, _aDir, travel, false);
      if (blocked) {
        this.pos.copy(blocked.point).addScaledVector(_aDir, -0.02);
        this.stuck = true; this.mesh.position.copy(this.pos);
        MC.Audio.play('arrow.hit', { pos: this.pos });
        return;
      }
      this.pos.add(_aStep);
    }
    if (player && !player.dead && Math.abs(player.pos.x - this.pos.x) < 0.5 && Math.abs(player.pos.z - this.pos.z) < 0.5 && this.pos.y > player.pos.y && this.pos.y < player.pos.y + 1.9) {
      player.hurt(2 + Math.floor(Math.random() * 2), 'arrow', this.pos, 0.3);
      this.dead = true; if (MC.game) MC.game.lastAttacker = 'Skeleton';
      return;
    }
    this.mesh.position.copy(this.pos);
    this.mesh.lookAt(_aLook.copy(this.pos).add(this.vel));
    this.mesh.rotateY(Math.PI);
  };

  // ---------------- selection box + break overlay + hand ----------------
  Game.prototype.buildSelection = function () {
    var geo = new THREE.EdgesGeometry(new THREE.BoxGeometry(1.004, 1.004, 1.004));
    this.selection = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.4 }));
    this.selection.visible = false; this.selection.renderOrder = 4; this.scene.add(this.selection);
    // break overlay: one cube per destroy stage, pointing at destroy_stage_<n>
    var stage0 = MC.Tex.layer('destroy_stage_0');
    this.breakGeos = [];
    for (var s = 0; s < 10; s++) {
      // .clone() is required -- BlockMesh.geometry() hands back a shared cached geometry.
      var g = MC.BlockMesh.geometry(MC.BLOCK.stone.id, 0, 15).clone();
      var d = g.attributes.aData; for (var i = 0; i < d.count; i++) { d.setX(i, stage0 + s); d.setY(i, 0); } d.needsUpdate = true;
      var col = g.attributes.aColor; for (i = 0; i < col.count; i++) col.setW(i, 1); col.needsUpdate = true;
      this.breakGeos.push(g);
    }
    // Dedicated variant sharing the world's live uniforms. The old code cloned `cutout` and
    // then reassigned cutout's own uniforms object, changing the alpha test for every
    // cutout block in the world as a side effect.
    this.breakMat = this.world.materials.variant({ alphaTest: 0.05, opacity: 1, transparent: true, depthWrite: false, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4 });
    this.breakMesh = new THREE.Mesh(this.breakGeos[0], this.breakMat);
    this.breakMesh.visible = false; this.breakMesh.renderOrder = 3; this.breakMesh.scale.setScalar(1.002); this.scene.add(this.breakMesh);
  };
  Game.prototype.buildHandScene = function () {
    this.handScene = new THREE.Scene();
    this.handGroup = new THREE.Group(); this.handScene.add(this.handGroup);
    var skinTex = new THREE.CanvasTexture(MC.Sprites.s.skin); skinTex.magFilter = THREE.NearestFilter; skinTex.minFilter = THREE.NearestFilter; skinTex.colorSpace = THREE.SRGBColorSpace;
    this.handShared = { uCamPos: { value: new THREE.Vector3() }, uFogColor: { value: new THREE.Vector3() }, uFogNear: { value: 1e5 }, uFogFar: { value: 2e5 } };
    this.armMat = MC.Shaders.createEntityMaterial(skinTex, this.handShared);
    var armGeo = MC.MobModel.makePart({ size: [4, 12, 4], uv: [40, 16] }, { width: 64, height: 64 });
    this.armMesh = new THREE.Mesh(armGeo, this.armMat); this.armGroup = new THREE.Group(); this.armGroup.add(this.armMesh); this.handGroup.add(this.armGroup);
    this.heldGroup = new THREE.Group(); this.handGroup.add(this.heldGroup); this.heldId = null; this.heldMesh = null; this.heldTintMats = null;
    this.handMats = null;
  };
  Game.prototype.clearHeldMesh = function () {
    if (this.heldMesh && this.heldGroup) this.heldGroup.remove(this.heldMesh);
    if (this.heldTintMats) { for (var i = 0; i < this.heldTintMats.length; i++) this.heldTintMats[i].dispose(); this.heldTintMats = null; }
    this.heldMesh = null; this.heldId = null;
  };
  Game.prototype.updateHand = function (dt, alpha) {
    var p = this.player; if (!p) return;
    var held = p.held(); var hid = held ? held.id : null;
    if (!this.handMats && this.world) { this.handMats = MC.Shaders.createChunkMaterials(this.texArray); this.handMats.uniforms.uFogNear.value = 1e5; this.handMats.uniforms.uFogFar.value = 2e5; }
    if (hid !== this.heldId) {
      this.clearHeldMesh();
      this.heldId = hid;
      if (hid) {
        this.heldMesh = MC.ItemMesh.stackMesh(hid, this.handMats);
        this.heldGroup.add(this.heldMesh);
        // Item sprite materials are cached and shared with world drops now, so give the hand
        // private clones before it starts tinting them by local light.
        var tint = [];
        this.heldMesh.traverse(function (o) {
          if (!o.material) return;
          if (Array.isArray(o.material)) {
            var arr = o.material.slice();
            for (var mi = 0; mi < arr.length; mi++) { if (arr[mi] && arr[mi].isMeshBasicMaterial) { arr[mi] = arr[mi].clone(); tint.push(arr[mi]); } }
            o.material = arr;
          } else if (o.material.isMeshBasicMaterial) { o.material = o.material.clone(); tint.push(o.material); }
        });
        this.heldTintMats = tint;
      }
    }
    var isBlock = hid && MC.ITEMS[hid].block >= 0 && !MC.BLOCKS[MC.ITEMS[hid].block].flat;
    this.armGroup.visible = !hid; this.heldGroup.visible = !!hid;
    var sw = p.swinging ? p.swing : 0; var f = Math.sin(Math.sqrt(sw) * Math.PI), f1 = Math.sin(sw * Math.PI);
    var eq = p.equip;
    // MC-like first person arm transform
    var g = this.handGroup; g.position.set(0, 0, 0); g.rotation.set(0, 0, 0);
    if (!hid) {
      // arm points from the lower-right (shoulder, near) toward the upper-left (hand, far)
      var a = this.armGroup;
      _armDir.set(0.3 - f * 0.3, 0.32 - f1 * 0.45, -0.85).normalize();
      _armNear.set(0.42 - f * 0.12, -0.6 - eq * 0.6 - f1 * 0.06, -0.5);
      a.position.copy(_armNear).addScaledVector(_armDir, 0.33);
      a.quaternion.setFromUnitVectors(_up, _negDir.copy(_armDir).negate());
      a.scale.setScalar(0.88);
      this.armMesh.position.set(0, 0, 0); this.armMesh.rotation.set(0, -0.8 + f * 0.4, 0);
    } else {
      var h = this.heldGroup; h.rotation.order = 'YXZ';
      if (isBlock) { h.position.set(0.6 - f * 0.5, -0.56 - eq * 0.6 - f1 * 0.35, -1.05 + f1 * 0.1); h.rotation.set(-f1 * 0.9, 0.78 - f * 0.9, 0); h.scale.setScalar(0.42); }
      else { var flat = MC.ITEMS[hid].block >= 0; h.position.set(0.68 - f * 0.5, -0.3 - eq * 0.6 - f1 * 0.45 - (flat ? 0.12 : 0), -0.95 + f1 * 0.1); h.rotation.set(-0.15 - f1 * 1.1, -0.4 - f * 0.6, -0.12 - f * 0.4); h.scale.setScalar(flat ? 0.45 : 0.62); }
    }
    // lighting for hand
    var br = this.world.brightnessAt(p.pos.x, p.pos.y + p.eyeHeight, p.pos.z, this.sky.dayLight);
    this.armMat.uniforms.uLight.value = br;
    if (this.handMats) {
      var wu = this.world.materials.uniforms, hu = this.handMats.uniforms;
      hu.uSkyTint.value.copy(wu.uSkyTint.value); hu.uTime.value = this.time; hu.uGamma.value = MC.Options.gamma;
      // held blocks are baked at light 15, so drive their brightness through uSkyLight
      var lb = this.world.getLightPacked(Math.floor(p.pos.x), Math.floor(p.pos.y + p.eyeHeight), Math.floor(p.pos.z));
      hu.uSkyLight.value = Math.max(lightCurve(lb >> 4) * this.sky.dayLight, lightCurve(lb & 15) * 0.95);
    }
    // dim held sprite items by local light (private clones, see above)
    if (this.heldTintMats && !isBlock) {
      var s = Math.pow(br, 0.8);
      for (var i = 0; i < this.heldTintMats.length; i++) { var m = this.heldTintMats[i]; if (m.color && !m.map) m.color.setScalar(s); }
    }
  };

  // ---------------- main loop ----------------
  Game.prototype.frame = function (t) {
    var self = this; requestAnimationFrame(function (tt) { self.frame(tt); });
    var dt = (t - this.last) / 1000; if (dt <= 0) return;
    if (MC.Options.maxFps < 260 && dt < 1 / MC.Options.maxFps) return;
    this.last = t; dt = Math.min(dt, 0.1); this.time += dt;
    this.fpsAcc = (this.fpsAcc || 0) + dt; this.fpsN = (this.fpsN || 0) + 1; if (this.fpsAcc >= 0.5) { MC.Hud.fps = this.fpsN / this.fpsAcc; this.fpsAcc = 0; this.fpsN = 0; }
    MC.Gui.setMouse(MC.Input.mouse.x, MC.Input.mouse.y);
    try {
      if (this.state === 'title') this.updateTitle(dt);
      else if (this.state === 'loading') this.updateLoading(dt);
      else if (this.state === 'playing') this.updatePlaying(dt);
    } catch (e) {
      // Throttled: an exception in the loop otherwise repeats identically every frame and
      // buries both the console and the chat log.
      if (this.time - this.errorLogT > 1) { this.errorLogT = this.time; console.error(e); if (this.chat) this.chat.add('§cError: ' + e.message); }
    }
    MC.Input.endFrame();
  };
  Game.prototype.handleScreenInput = function () {
    var input = MC.Input, m = input.mouse; var s = this.screen; if (!s) return;
    for (var i = 0; i < m.clicks.length; i++) { var c = m.clicks[i]; var gx = c.x / MC.Gui.S, gy = c.y / MC.Gui.S; if (c.down) s.mouseDown(gx, gy, c.button); else s.mouseUp(gx, gy, c.button); }
    if (m.moved) s.mouseMove(MC.Gui.mx, MC.Gui.my);
    if (m.wheel) s.wheel(m.wheel);
    // Only this frame's presses. Previously Object.keys(input.keys).filter(...), i.e. two
    // array allocations per frame across every key ever touched.
    var codes = input.pressedCodes;
    for (i = 0; i < codes.length; i++) {
      var code = codes[i];
      if (s.key(code)) continue;
      if (code === 'Escape') { if (this.state === 'playing') this.closeScreen(); else if (s.parent) this.openScreen(s.parent); }
      else if (code === 'F11') this.toggleFullscreen();
    }
  };
  Game.prototype.updateTitle = function (dt) {
    this.renderPanorama(dt);
    if (this.screen) { this.screen.tick(dt); this.handleScreenInput(); }
    MC.Gui.begin();
    if (this.screen) this.screen.render();
    if (!this.pano || !this.pano.ready) { var g = MC.Gui; g.drawBackground(); g.textC('Loading...', g.W / 2, g.H / 2 - 4, '#ffffff', true); }
  };
  Game.prototype.updateLoading = function (dt) {
    this.loadT += dt;
    var w = this.world; var total = w.totalTarget || 1; var done = MC.clamp(1 - w.pendingMesh / total, 0, 1);
    var readyNear = w.readyFraction(2) >= 1 && this.loadT > 0.5;
    if (readyNear && (w.readyFraction(Math.min(4, w.renderDistance)) >= 1 || this.loadT > 12)) { this.finishLoading(); return; }
    var g = MC.Gui; g.begin(); g.drawBackground();
    g.textC('Loading level', g.W / 2, Math.floor(g.H / 2) - 20, '#ffffff', true);
    g.textC(this.loadStage, g.W / 2, Math.floor(g.H / 2) + 4, '#ffffff', true);
    var bx = Math.floor(g.W / 2) - 50, by = Math.floor(g.H / 2) + 16;
    g.rect(bx, by, 100, 2, '#808080'); g.rect(bx, by, Math.round(done * 100), 2, '#80ff20');
    this.renderer.setClearColor(0x000000); this.renderer.clear(true, true, false);
  };
  Game.prototype.updatePlaying = function (dt) {
    var input = MC.Input, p = this.player, world = this.world, O = MC.Options;
    var paused = !!(this.screen && this.screen.pausesGame);
    // global keys
    if (!this.chat.open && !(this.screen && this.screen.focus)) {
      if (input.pressed('F1')) { MC.Hud.hidden = !MC.Hud.hidden; this.crosshair.style.display = (MC.Hud.hidden || this.screen) ? 'none' : 'block'; }
      if (input.pressed('F3')) MC.Hud.debug = !MC.Hud.debug;
      if (input.pressed('F11')) this.toggleFullscreen();
    }
    if (this.screen) {
      this.screen.tick(dt); this.handleScreenInput();
      p.controlsEnabled = false;
    } else if (this.chat.open) {
      p.controlsEnabled = false;
      if (input.pressed('Escape')) this.chat.close();
    } else {
      p.controlsEnabled = true;
      if (input.pressed('Escape')) this.openScreen(new MC.Screens.PauseScreen(this));
      else if (input.pressed('inventory')) this.openScreen(p.isCreative() ? new MC.Inventory.Screens.CreativeScreen(this, this.lastCreativeTab || 2) : new MC.Inventory.Screens.InventoryScreen(this));
      else if (input.pressed('chat')) { this.chat.openChat(''); MC.Input.unlock(); }
      else if (input.pressed('command')) { this.chat.openChat('/'); MC.Input.unlock(); }
      else if (!input.locked && (input.clicked(0) || input.clicked(1) || input.clicked(2))) MC.Input.lock();
    }
    if (this.screen && this.screen.constructor === MC.Inventory.Screens.CreativeScreen) this.lastCreativeTab = this.screen.tab;
    if (!paused) {
      if (O.invertMouse) input.mouse.dy = -input.mouse.dy;
      p.update(dt, input, O.sensitivity);
      world.setCenter(Math.floor(p.pos.x) >> 4, Math.floor(p.pos.z) >> 4);
      this.sky.time += dt * 20;
      this.entities.update(dt, p, this.sky.dayLight);
      MC.Mobs.update(dt, this.sky.dayLight);
      this.particles.dayLight = this.sky.dayLight; this.particles.update(dt, world);
      this.tickFurnaces(dt); this.tickSaplings(); this.tickAmbient(dt);
      MC.Hud.tick(dt, p);
      this.autosaveT += dt; if (this.autosaveT > 60) { this.autosaveT = 0; this.saveWorld(); }
      if (this.shake > 0) this.shake = Math.max(0, this.shake - dt);
    }
    this.render(dt, paused);
  };
  Game.prototype.tickFurnaces = function (dt) {
    var p = this.player;
    for (var k in this.furnaces) {
      var f = this.furnaces[k];
      // Coordinates parsed once per furnace. This used to be k.split(',').map(Number) plus a
      // Vector3 allocation and a sqrt, for every furnace, on every frame.
      if (f.px === undefined) { var c = k.split(','); f.px = +c[0]; f.py = +c[1]; f.pz = +c[2]; }
      var input = f.slots[0], fuel = f.slots[1], out = f.slots[2];
      var result = input ? MC.SMELT[input.id] : null;
      var canOut = !!result && (!out || (out.id === result && out.count < MC.ITEMS[result].stack));
      if (f.burn > 0) f.burn -= dt;
      if (f.burn <= 0 && canOut && fuel && MC.FUEL[fuel.id]) { f.burn = MC.FUEL[fuel.id]; f.burnMax = f.burn; fuel.count--; if (fuel.id === 'lava_bucket') f.slots[1] = { id: 'bucket', count: 1, damage: 0 }; else if (fuel.count <= 0) f.slots[1] = null; }
      if (f.burn > 0 && canOut) { f.progress += dt / 10; if (f.progress >= 1) { f.progress = 0; input.count--; if (input.count <= 0) f.slots[0] = null; if (out) out.count++; else f.slots[2] = { id: result, count: 1, damage: 0 }; } }
      else if (!canOut) f.progress = Math.max(0, f.progress - dt / 5);
      if (f.burn < 0) f.burn = 0;
      // lit furnaces emit smoke while the player is within 24 blocks
      if (f.burn > 0 && Math.random() < dt * 3) {
        var dx = f.px - p.pos.x, dy = f.py - p.pos.y, dz = f.pz - p.pos.z;
        if (dx * dx + dy * dy + dz * dz < 576) MC.Particles.smoke(f.px + 0.5, f.py + 1.05, f.pz + 0.5, 1);
      }
    }
  };
  Game.prototype.tickSaplings = function () {
    for (var i = this.saplings.length - 1; i >= 0; i--) {
      var s = this.saplings[i]; if (this.time < s.t) continue;
      this.saplings.splice(i, 1);
      var id = this.world.getBlock(s.x, s.y, s.z);
      if (id <= 0 || !(/_sapling$/).test(MC.BLOCKS[id].name)) continue;
      var light = this.world.getLightPacked(s.x, s.y, s.z);
      if ((light >> 4) < 9 && (light & 15) < 9) { s.t = this.time + 30; this.saplings.push(s); continue; }
      this.world.worker.postMessage({ type: 'growTree', x: s.x, y: s.y, z: s.z, kind: s.type, seed: (Math.random() * 1e9) | 0 });
    }
  };
  Game.prototype.tickAmbient = function (dt) {
    var p = this.player; MC.Audio.setListener(p.pos.x, p.pos.y + p.eyeHeight, p.pos.z, p.yaw);
    this.ambientT = (this.ambientT || 0) - dt;
    if (this.ambientT <= 0) {
      this.ambientT = 4 + Math.random() * 6;
      if ((this.world.getLightPacked(Math.floor(p.pos.x), Math.floor(p.pos.y), Math.floor(p.pos.z)) >> 4) === 0 && Math.random() < 0.2) MC.Audio.play('ambient.cave', { volume: 0.5 });
    }
    // torch / lava / fire particles near the player
    this.fxT = (this.fxT || 0) - dt;
    if (this.fxT > 0) return;
    this.fxT = 0.12;
    var w = this.world; var bx = Math.floor(p.pos.x), by = Math.floor(p.pos.y), bz = Math.floor(p.pos.z);
    for (var i = 0; i < 40; i++) {
      var x = bx + Math.floor(Math.random() * 33) - 16, y = by + Math.floor(Math.random() * 25) - 12, z = bz + Math.floor(Math.random() * 33) - 16;
      var id = w.getBlock(x, y, z);
      if (id === MC.BLOCK.torch.id) {
        var meta = w.getMeta(x, y, z); var ox = 0.5, oz = 0.5, oy = 0.7;
        if (meta === 1) ox = 0.1; else if (meta === 2) ox = 0.9; else if (meta === 3) oz = 0.1; else if (meta === 4) oz = 0.9;
        if (meta) oy = 0.85;
        MC.Particles.flame(x + ox, y + oy, z + oz);
        if (Math.random() < 0.3) MC.Particles.smoke(x + ox, y + oy + 0.1, z + oz, 1);
      } else if (id === MC.BLOCK.lava.id && w.getBlock(x, y + 1, z) === 0 && Math.random() < 0.3) {
        MC.Particles.flame(x + Math.random(), y + 1, z + Math.random());
        if (Math.random() < 0.05) MC.Audio.play('lava.pop', { pos: _vpos.set(x, y, z), volume: 0.4 });
      }
    }
  };

  Game.prototype.render = function (dt, paused) {
    var p = this.player, world = this.world, O = MC.Options; var alpha = paused ? 1 : p.alpha();
    // camera
    var eye = p.getEyePos(alpha); var cam = this.camera;
    cam.rotation.order = 'YXZ';
    var yaw = p.yaw, pitch = p.pitch, roll = 0;
    if (O.bobbing && !p.dead) {
      var bob = MC.lerp(p.prevBob, p.bob, alpha); var f = -(MC.lerp(p.prevWalkDist, p.walkDist, alpha));
      var bx = Math.sin(f * Math.PI) * bob * 0.5, by = -Math.abs(Math.cos(f * Math.PI) * bob);
      _right.set(Math.cos(yaw), 0, -Math.sin(yaw));
      eye.addScaledVector(_right, bx * 0.6); eye.y += by * 0.6;
      roll += Math.sin(f * Math.PI) * bob * 3 * Math.PI / 180;
      pitch += Math.abs(Math.cos(f * Math.PI - 0.2) * bob) * 5 * Math.PI / 180;
    }
    if (p.hurtTime > 0 && O.damageTilt > 0) { var ht = p.hurtTime / 0.5; var hf = Math.sin(ht * ht * ht * ht * Math.PI); roll += hf * 14 * Math.PI / 180 * (p.hurtYaw > 0 ? 1 : -1) * O.damageTilt; }
    if (this.shake > 0) { roll += (Math.random() - 0.5) * this.shake * 0.05; pitch += (Math.random() - 0.5) * this.shake * 0.03; }
    if (p.dead) { pitch = MC.lerp(pitch, 0, Math.min(1, p.deathTime * 2)); roll = MC.lerp(0, Math.PI / 2 * 0.9, Math.min(1, p.deathTime * 1.5)); eye.y -= Math.min(1, p.deathTime * 1.5) * 1.3; }
    cam.position.copy(eye); cam.rotation.set(-pitch, yaw, roll);
    var fovMult = p.sprinting ? 1.15 : 1;
    this.fovMult = this.fovMult === undefined ? 1 : this.fovMult + (fovMult - this.fovMult) * Math.min(1, dt * 8);
    var fov = O.fov * this.fovMult; if (p.headInWater) fov *= 0.9;
    if (Math.abs(cam.fov - fov) > 0.01) { cam.fov = fov; cam.updateProjectionMatrix(); }
    // sky + fog + uniforms
    var biome = world.getBiome(Math.floor(p.pos.x), Math.floor(p.pos.z));
    this.sky.update(dt, cam.position, biome, p.headInWater, cam.far);
    world.updateUniforms(this.time, cam.position);
    if (p.headInWater) world.setFog(2, 22);
    var lavaHead = world.getBlock(Math.floor(eye.x), Math.floor(eye.y), Math.floor(eye.z)) === MC.BLOCK.lava.id;
    if (lavaHead) { world.setFog(0.2, 2.5); this.sky.fogColor.setRGB(0.6, 0.1, 0); world.materials.uniforms.uFogColor.value.set(0.6, 0.1, 0); }
    // selection + break overlay
    var hit = p.target;
    if (hit && !p.dead && !this.screen) {
      var boxes = world.hitBoxes(hit.id); var b = boxes ? boxes[0] : FALLBACK_BOX;
      this.selection.visible = true;
      this.selection.position.set(hit.x + (b[0] + b[3]) / 2, hit.y + (b[1] + b[4]) / 2, hit.z + (b[2] + b[5]) / 2);
      this.selection.scale.set(b[3] - b[0], b[4] - b[1], b[5] - b[2]);
    } else this.selection.visible = false;
    if (hit && p.mining.target && p.mining.progress > 0) {
      this.breakMesh.geometry = this.breakGeos[Math.min(9, Math.floor(p.mining.progress * 10))];
      this.breakMesh.visible = true; this.breakMesh.position.set(hit.x + 0.5, hit.y + 0.5, hit.z + 0.5);
    } else this.breakMesh.visible = false;
    // render world
    var r = this.renderer;
    r.setClearColor(this.sky.fogColor); r.clear(true, true, false);
    r.render(this.scene, cam);
    this.stats.chunksRendered = r.info.render.calls;
    // hand
    if (!MC.Hud.hidden && !p.dead) { this.updateHand(dt, alpha); r.clearDepth(); r.render(this.handScene, this.handCamera); }
    // GUI
    var g = MC.Gui; g.begin();
    if (p.headInWater) g.rect(0, 0, g.W, g.H, 'rgba(10,30,110,0.35)');
    if (lavaHead) g.rect(0, 0, g.W, g.H, 'rgba(200,60,0,0.6)');
    if (p.fireTicks > 0 && !p.dead) g.gradient(0, g.H * 0.6, g.W, g.H * 0.4, 'rgba(255,120,0,0)', 'rgba(255,90,0,0.55)');
    MC.Hud.render(this);
    this.chat.render();
    if (this.screen) this.screen.render();
    this.crosshair.style.display = (this.screen || MC.Hud.hidden || this.chat.open) ? 'none' : 'block';
  };

  MC.Game = Game;
  window.addEventListener('load', function () { MC.game = new Game(); MC.game.init(); });
})();

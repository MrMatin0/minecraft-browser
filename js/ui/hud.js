// In-game HUD: hotbar, hearts, hunger, armor, air, XP, item name, F3 debug overlay.
(function () {
  var itemNameTimer = 0, lastSelected = -1, lastHeld = null;
  // F3 overlay text is rebuilt at 5 Hz instead of every frame. Building ~28 concatenated
  // strings plus two arrays per frame is a silly cost to pay while looking at a frame timer.
  var dbgLeft = [], dbgRight = [], dbgT = -1;
  var Hud = {
    hidden: false, debug: false, fps: 0,
    tick: function (dt, player) {
      var held = player.held(); var hid = held ? held.id : null;
      if (player.selected !== lastSelected || hid !== lastHeld) { if (hid) itemNameTimer = 2.5; lastSelected = player.selected; lastHeld = hid; }
      if (itemNameTimer > 0) itemNameTimer -= dt;
    },
    render: function (game) {
      var g = MC.Gui, c = g.ctx, W = g.W, H = g.H, S = MC.Sprites.s; var p = game.player;
      if (this.hidden) return;
      var cx = Math.floor(W / 2);
      var i, x, y, v;
      // hotbar
      var hx = cx - 91, hy = H - 22;
      c.drawImage(S.hotbar, hx, hy);
      c.drawImage(S.hotbar_selection, hx - 1 + p.selected * 20, hy - 1);
      for (i = 0; i < 9; i++) { var st = p.inventory.slots[i]; if (st) g.drawItemStack(st, hx + 3 + i * 20, hy + 3); }
      var off = p.inventory.slots[40]; if (off) { c.drawImage(S.offhand, hx - 29, H - 23); g.drawItemStack(off, hx - 26, H - 20); }
      var survival = !p.isCreative();
      if (survival) {
        // health
        var hp = Math.ceil(p.health), maxHp = p.maxHealth;
        var lowShake = p.health <= 4;
        var ticks = Math.floor(game.time * 20);
        var regen = -1; if (p.hunger >= 18 && p.health < maxHp) regen = Math.floor(ticks / 2) % 30;
        for (i = 0; i < 10; i++) {
          x = cx - 91 + i * 8; y = H - 39;
          if (lowShake) y += (MC.hash3(i, ticks, 3) % 3) - 1;
          if (regen === i) y -= 2;
          c.drawImage(S.heart_container, x, y);
          v = i * 2;
          if (hp > v + 1) c.drawImage(S.heart_full, x, y); else if (hp > v) c.drawImage(S.heart_half, x, y);
        }
        // hunger (right to left)
        var hunger = p.hunger;
        var hungerShake = p.saturation <= 0 && hunger <= 6 && ticks % 4 < 2;
        for (i = 0; i < 10; i++) {
          x = cx + 91 - 9 - i * 8; y = H - 39;
          if (hungerShake) y += (MC.hash3(i, ticks, 9) % 3) - 1;
          c.drawImage(S.food_container, x, y);
          v = i * 2;
          if (hunger > v + 1) c.drawImage(S.food_full, x, y); else if (hunger > v) c.drawImage(S.food_half, x, y);
        }
        // armor
        var armor = p.armorPoints();
        if (armor > 0) for (i = 0; i < 10; i++) { x = cx - 91 + i * 8; y = H - 49; c.drawImage(S.armor_container, x, y); v = i * 2; if (armor > v + 1) c.drawImage(S.armor_full, x, y); else if (armor > v) c.drawImage(S.armor_half, x, y); }
        // air
        if (p.headInWater || p.air < 300) {
          var bubbles = Math.ceil((p.air - 2) * 10 / 300), pops = Math.ceil(p.air * 10 / 300) - bubbles;
          for (i = 0; i < bubbles + pops; i++) { x = cx + 91 - 9 - i * 8; y = H - 49; c.drawImage(i < bubbles ? S.bubble : S.bubble_pop, x, y); }
        }
        // xp bar
        var xb = cx - 91, xy = H - 29;
        c.drawImage(S.xp_bg, xb, xy);
        var fw = Math.min(182, Math.floor(p.xp * 183)); if (fw > 0) c.drawImage(S.xp_fill, 0, 0, fw, 5, xb, xy, fw, 5);
        if (p.level > 0) { var t = String(p.level); var tx = cx - Math.floor(MC.Font.width(t) / 2), ty = H - 35; MC.Font.draw(c, t, tx + 1, ty, '#000000', false); MC.Font.draw(c, t, tx - 1, ty, '#000000', false); MC.Font.draw(c, t, tx, ty + 1, '#000000', false); MC.Font.draw(c, t, tx, ty - 1, '#000000', false); MC.Font.draw(c, t, tx, ty, '#80ff20', false); }
      }
      // held item name
      if (itemNameTimer > 0) {
        var shown = p.held();
        if (shown) { var a = MC.clamp(itemNameTimer * 4, 0, 1); c.globalAlpha = a; var name = MC.ITEMS[shown.id] ? MC.ITEMS[shown.id].label : shown.id; g.textC(name, cx, H - 59 + (survival ? 0 : 14), '#ffffff', true); c.globalAlpha = 1; }
      }
      if (this.debug) this.renderDebug(game);
    },
    buildDebug: function (game) {
      var p = game.player, pos = p.pos;
      var yaw = MC.mod(p.yaw * 180 / Math.PI + 180, 360) - 180;
      var f = MC.mod(-p.yaw + Math.PI, Math.PI * 2);
      var dirs = ['south (Towards positive Z)', 'west (Towards negative X)', 'north (Towards negative Z)', 'east (Towards positive X)'];
      var facing = dirs[Math.floor(((f + Math.PI / 4) % (Math.PI * 2)) / (Math.PI / 2)) % 4];
      var bx = Math.floor(pos.x), by = Math.floor(pos.y), bz = Math.floor(pos.z);
      var light = game.world.getLight(bx, by, bz); var biome = game.world.getBiome(bx, bz);
      var mobs = MC.Mobs.list.length, ents = game.entities.list.length;
      dbgLeft = [
        'Minecraft ' + MC.VERSION + ' (' + MC.VERSION + '/vanilla)',
        Math.round(this.fps) + ' fps T: inf vsync fancy-clouds B: 2',
        'C: ' + game.stats.chunksRendered + '/' + game.world.meshCount + ' (s) D: ' + game.world.renderDistance + ', pC: 000, pU: 00, aB: ' + game.world.pendingMesh,
        'E: ' + (ents + mobs) + '/' + (ents + mobs),
        'P: ' + game.particles.n + '. T: All: ' + mobs,
        'Client Chunk Cache: ' + game.world.chunks.size + ', ' + game.world.meshCount,
        '',
        'minecraft:overworld FC: 0',
        '',
        'XYZ: ' + pos.x.toFixed(3) + ' / ' + pos.y.toFixed(5) + ' / ' + pos.z.toFixed(3),
        'Block: ' + bx + ' ' + by + ' ' + bz + ' [' + (bx & 15) + ' ' + (by & 15) + ' ' + (bz & 15) + ']',
        'Chunk: ' + (bx >> 4) + ' ' + (by >> 4) + ' ' + (bz >> 4) + ' [' + (bx & 15) + ' ' + (by & 15) + ' ' + (bz & 15) + ']',
        'Facing: ' + facing + ' (' + (-yaw).toFixed(1) + ' / ' + (p.pitch * 180 / Math.PI).toFixed(1) + ')',
        'Client Light: ' + Math.max(light.sky, light.block) + ' (' + light.sky + ' sky, ' + light.block + ' block)',
        'Biome: minecraft:' + biome.name,
        'Local Difficulty: 1.50 // 0.00 (Day ' + Math.floor(game.sky.time / 24000) + ')',
        'Time: ' + Math.floor(game.sky.time % 24000) + ' ticks',
        'Sounds: web audio synth'
      ];
      var mem = performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) + 'MB' : 'n/a';
      dbgRight = [
        'JavaScript: ' + (navigator.userAgent.match(/Chrome\/[\d.]+/) || ['browser'])[0],
        'Mem: ' + mem,
        'CPU: ' + (navigator.hardwareConcurrency || '?') + 'x',
        '',
        'Display: ' + MC.Gui.pw + 'x' + MC.Gui.ph + ' (' + game.rendererName + ')',
        'WebGL2 / Three.js r' + THREE.REVISION,
        ''
      ];
      if (p.target) {
        var B = MC.BLOCKS[p.target.id];
        dbgRight.push('Targeted Block: ' + p.target.x + ', ' + p.target.y + ', ' + p.target.z, 'minecraft:' + B.name);
        var meta = game.world.getMeta(p.target.x, p.target.y, p.target.z); if (meta) dbgRight.push('meta: ' + meta);
      }
      if (p.targetMob) dbgRight.push('Targeted Entity: minecraft:' + p.targetMob.type, 'health: ' + p.targetMob.health);
    },
    renderDebug: function (game) {
      var g = MC.Gui, c = g.ctx, W = g.W;
      if (dbgT < 0 || game.time - dbgT > 0.2) { dbgT = game.time; this.buildDebug(game); }
      var i, w;
      for (i = 0; i < dbgLeft.length; i++) { if (!dbgLeft[i]) continue; w = MC.Font.width(dbgLeft[i]); c.fillStyle = 'rgba(80,80,80,0.5)'; c.fillRect(1, 1 + i * 9, w + 1, 9); g.text(dbgLeft[i], 2, 2 + i * 9, '#e0e0e0', false); }
      for (i = 0; i < dbgRight.length; i++) { if (!dbgRight[i]) continue; w = MC.Font.width(dbgRight[i]); c.fillStyle = 'rgba(80,80,80,0.5)'; c.fillRect(W - w - 3, 1 + i * 9, w + 1, 9); g.text(dbgRight[i], W - w - 2, 2 + i * 9, '#e0e0e0', false); }
    }
  };
  MC.Hud = Hud;
})();

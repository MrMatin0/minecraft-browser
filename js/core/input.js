// Keyboard / mouse / pointer-lock input. Exposes injectMouse for the headless harness.
(function () {
  var keys = {}, pressed = {}, released = {};
  // Codes newly pressed / released this frame. Iterating these is O(events) instead of
  // O(every key ever touched), which is what Object.keys(keys) degrades into.
  var pressedCodes = [], releasedCodes = [];
  var mouse = { x: 0, y: 0, dx: 0, dy: 0, buttons: 0, wheel: 0, clicks: [], locked: false, moved: false };
  var textTarget = null; // callback receiving typed characters when a text field is focused
  var canvas = null;
  // getBoundingClientRect() forces a layout flush. Doing it on every mousemove is a
  // measurable stall, so cache it and invalidate only when the layout can actually change.
  var rectL = 0, rectT = 0, rectDirty = true;
  var BIND = {
    forward: 'KeyW', back: 'KeyS', left: 'KeyA', right: 'KeyD', jump: 'Space', sneak: 'ShiftLeft', sprint: 'ControlLeft',
    inventory: 'KeyE', drop: 'KeyQ', chat: 'KeyT', command: 'Slash', debug: 'F3', hideGui: 'F1', perspective: 'F5', fullscreen: 'F11', swapHands: 'KeyF', pickBlock: 'MouseMiddle'
  };
  function refreshRect() {
    if (!rectDirty || !canvas) return;
    var r = canvas.getBoundingClientRect(); rectL = r.left; rectT = r.top; rectDirty = false;
  }
  function invalidateRect() { rectDirty = true; }
  function press(code) { if (!keys[code]) { pressed[code] = true; pressedCodes.push(code); } keys[code] = true; }
  function init(cv) {
    canvas = cv; invalidateRect();
    window.addEventListener('keydown', function (e) {
      if (e.code === 'F11' || e.code === 'F3' || e.code === 'F1' || e.code === 'F5' || e.code === 'Tab' || (e.code === 'Slash' && !textTarget)) e.preventDefault();
      if (textTarget) {
        if (e.key === 'Backspace') textTarget('\b'); else if (e.key === 'Enter') textTarget('\n'); else if (e.key === 'Escape') textTarget('\x1b');
        else if (e.key === 'ArrowLeft') textTarget('\x11'); else if (e.key === 'ArrowRight') textTarget('\x12'); else if (e.key === 'ArrowUp') textTarget('\x13'); else if (e.key === 'ArrowDown') textTarget('\x14');
        else if (e.key === 'Tab') textTarget('\t');
        else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey) textTarget(e.key);
        else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'v') { if (navigator.clipboard && navigator.clipboard.readText) navigator.clipboard.readText().then(function (t) { for (var i = 0; i < t.length; i++) textTarget(t[i]); }).catch(function () { }); }
        if (e.code !== 'Escape' && e.code !== 'F11') { e.preventDefault(); return; }
      }
      press(e.code);
      if (e.code === 'Space' || e.code.indexOf('Arrow') === 0) e.preventDefault();
    });
    window.addEventListener('keyup', function (e) { keys[e.code] = false; if (!released[e.code]) { released[e.code] = true; releasedCodes.push(e.code); } });
    window.addEventListener('blur', function () { for (var k in keys) keys[k] = false; mouse.buttons = 0; });
    window.addEventListener('resize', invalidateRect);
    window.addEventListener('scroll', invalidateRect, true);
    document.addEventListener('fullscreenchange', invalidateRect);
    document.addEventListener('mousemove', function (e) {
      if (mouse.locked) { mouse.dx += e.movementX; mouse.dy += e.movementY; }
      refreshRect(); mouse.x = e.clientX - rectL; mouse.y = e.clientY - rectT; mouse.moved = true;
    });
    document.addEventListener('mousedown', function (e) {
      mouse.buttons |= (1 << e.button);
      refreshRect(); mouse.x = e.clientX - rectL; mouse.y = e.clientY - rectT;
      mouse.clicks.push({ button: e.button, x: mouse.x, y: mouse.y, down: true });
      if (e.button === 1) e.preventDefault();
    });
    document.addEventListener('mouseup', function (e) { mouse.buttons &= ~(1 << e.button); mouse.clicks.push({ button: e.button, x: mouse.x, y: mouse.y, down: false }); });
    document.addEventListener('contextmenu', function (e) { e.preventDefault(); });
    document.addEventListener('wheel', function (e) { mouse.wheel += e.deltaY > 0 ? 1 : (e.deltaY < 0 ? -1 : 0); if (mouse.locked) e.preventDefault(); }, { passive: false });
    document.addEventListener('pointerlockchange', function () { mouse.locked = document.pointerLockElement === canvas; if (!mouse.locked && MC.Input.onUnlock) MC.Input.onUnlock(); });
    document.addEventListener('pointerlockerror', function () { mouse.locked = false; });
  }
  function lock() {
    if (!canvas || mouse.locked) return;
    var retry = function () { try { var q = canvas.requestPointerLock(); if (q && q.catch) q.catch(function () { }); } catch (e) { } };
    try {
      var p = canvas.requestPointerLock({ unadjustedMovement: true });
      if (p && p.catch) p.catch(retry);
    } catch (e) { retry(); }
  }
  function unlock() { if (document.exitPointerLock && mouse.locked) document.exitPointerLock(); }
  function down(action) { return !!keys[BIND[action] || action]; }
  function wasPressed(action) { return !!pressed[BIND[action] || action]; }
  function wasReleased(action) { return !!released[BIND[action] || action]; }
  // True if the given mouse button went down this frame (replaces mouse.clicks.some(...)
  // closures that were being allocated several times per frame).
  function clicked(button) {
    for (var i = 0; i < mouse.clicks.length; i++) { var c = mouse.clicks[i]; if (c.down && c.button === button) return true; }
    return false;
  }
  function endFrame() {
    for (var i = 0; i < pressedCodes.length; i++) pressed[pressedCodes[i]] = false;
    for (i = 0; i < releasedCodes.length; i++) released[releasedCodes[i]] = false;
    pressedCodes.length = 0; releasedCodes.length = 0;
    mouse.dx = 0; mouse.dy = 0; mouse.wheel = 0; mouse.clicks.length = 0; mouse.moved = false;
  }
  function injectMouse(dx, dy) { mouse.dx += dx; mouse.dy += dy; }
  function setTextTarget(fn) { textTarget = fn; }
  MC.Input = {
    init: init, lock: lock, unlock: unlock, down: down, pressed: wasPressed, released: wasReleased, clicked: clicked,
    keys: keys, pressedCodes: pressedCodes, releasedCodes: releasedCodes, mouse: mouse,
    endFrame: endFrame, injectMouse: injectMouse, setTextTarget: setTextTarget, BIND: BIND, onUnlock: null,
    get locked() { return mouse.locked; }, simulateLock: false
  };
})();

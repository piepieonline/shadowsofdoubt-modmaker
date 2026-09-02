/**
 * A three.js view in a container: renderer, camera, orbit controls, and the plumbing
 * around them that has nothing to do with what is being looked at.
 *
 * Two panes want a 3D view and want to steer it the same way -- the building flow's
 * floorplan, and the furniture creator's model. What they draw has nothing in common;
 * how a camera is bound to a canvas, which button orbits, what the arrow keys do, when a
 * frame is scheduled and what has to be let go of afterwards is identical, and was written
 * once for the floorplan before there was a second caller.
 *
 * This is that half, extracted rather than copied. A second bootstrap would be the drift
 * `refs/README.md` describes for `ddsMap.json`: two copies, far enough apart that nobody
 * reads them together, disagreeing about a question with one right answer -- and here the
 * disagreement would be a trackpad gesture that works in one pane and not the other.
 *
 * ## What it does not do
 *
 * It owns no content. Nothing here knows about floors, furniture, lights or materials: the
 * caller adds to `scene`, disposes what it added through `onDispose`, and calls
 * `invalidate` when something it drew has changed. `three` is loaded on first use through
 * the import map in `index.html`, so a flow that never opens a 3D view fetches none of it.
 *
 * ## Units are the caller's
 *
 * The floorplan works in nodes, where a cell is 1 across; the furniture creator works in
 * metres, where a node is 1.8. So every distance here -- how near the camera may stand,
 * how far, where it starts -- is an option rather than a constant, and the defaults are
 * only the floorplan's because that is the view that had them first.
 */

/**
 * How far one press of a camera key moves.
 *
 * Not options. These are about how a held key feels rather than about what is being
 * looked at: a browser repeats at about thirty a second, so a step small enough to aim
 * with is still a turn in a second or so of holding. Zoom and pan are proportional to the
 * distance already stood off, which is what makes one set of numbers work at both scales.
 */
const KEY_ORBIT = 0.06;
const KEY_ZOOM = 1.1;
const KEY_PAN = 0.05;

/** Straight down is a degenerate spherical angle, so the tilt stops just short of it. */
const MIN_POLAR = 0.001;

/**
 * Build a view inside a container element.
 *
 * @param container the element to fill. Sized by it, and observed for resizes.
 * @param options
 *   `eye` and `target` where the camera stands and what it looks at, in the caller's units
 *   `background` the clear colour
 *   `fov` / `near` / `far` the camera's frustum -- `near` matters: half a metre is
 *      sensible at floorplan scale and clips through a chair at furniture scale
 *   `minDistance` / `maxDistance` how close and how far the camera may be pulled
 *   `maxPolarAngle` how far the camera may be tilted, stopping it going under the model
 *   `reserveLeftButton` whether the left button belongs to something other than the camera
 *   `label` what the canvas is called, for the screen reader
 *
 * Returns the pieces the caller needs to draw with, plus the handful of verbs worth
 * having in one place. The three.js module is handed back rather than re-imported by the
 * caller: importing `three` twice from two specifiers is two module instances and two
 * incompatible sets of classes, which is the same trap the import map's troika entries
 * exist to avoid.
 */
export async function createViewer(container, options = {}) {
    const {
        eye = [0, 10, 20],
        target = [0, 0, 0],
        background = 0x14161a,
        fov = 45,
        near = 0.5,
        far = 500,
        minDistance = 4,
        maxDistance = 80,
        maxPolarAngle = Math.PI * 0.48,
        reserveLeftButton = false,
        label = '3D view',
    } = options;

    const THREE = await import('three');
    const { OrbitControls } = await import('three/addons/controls/OrbitControls.js');

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio ?? 1, 2));
    container.appendChild(renderer.domElement);
    renderer.domElement.style.display = 'block';
    renderer.domElement.style.width = '100%';
    renderer.domElement.style.height = '100%';

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(background);

    const camera = new THREE.PerspectiveCamera(fov, 1, near, far);
    camera.position.set(...eye);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.target.set(...target);
    controls.enableDamping = true;
    controls.maxPolarAngle = maxPolarAngle;
    controls.minDistance = minDistance;
    controls.maxDistance = maxDistance;

    /*
     * Who the left button belongs to.
     *
     * A view with tools in it -- the floorplan, where dragging paints -- cannot have the
     * left button also swinging the camera, so it is given nothing: a mouse action of null
     * falls through OrbitControls' switch and leaves it in no state at all. Orbiting moves
     * to the middle and right buttons, either of which does it.
     *
     * A view without tools has no reason to withhold it, and withholding it there would
     * be worse than useless: a pane whose obvious drag does nothing reads as broken.
     *
     * Pan is not given a button of its own and does not need one: OrbitControls pans
     * instead of rotating whenever ctrl or shift is held on a button set to ROTATE.
     */
    controls.mouseButtons = {
        LEFT: reserveLeftButton ? null : THREE.MOUSE.ROTATE,
        MIDDLE: THREE.MOUSE.ROTATE,
        RIGHT: THREE.MOUSE.ROTATE,
    };

    controls.update();

    /*
     * Alt lends the left button to the camera for the length of one drag.
     *
     * Only where it was withheld in the first place. A Mac trackpad has no middle button
     * at all, and its right one is a two-finger click that cannot be held through a drag
     * without a third finger -- so orbiting was reachable only by the gesture a trackpad
     * is worst at. Alt+drag is what Maya, Sketchfab and most orbit views on the web use,
     * and here it collides with nothing: OrbitControls picks pan over rotate on ctrl, meta
     * and shift and never reads alt, and a tool's modifiers are those same three.
     * Alt+shift+drag pans, for free.
     *
     * Which button orbits has to be settled before OrbitControls sees the press, and it
     * binds its own pointerdown on the canvas as it is constructed -- ahead of any tool's.
     * Listeners on one element run in the order they were added whatever phase they asked
     * for, so no second canvas listener can get in front of it. A capture listener on the
     * container can: an ancestor's capture phase runs before the target's handlers.
     *
     * Read on the press alone. Alt taken up or put down part way through does not change
     * what the drag already is.
     */
    const chooseLeftButton = (event) => {
        controls.mouseButtons.LEFT = event.altKey ? THREE.MOUSE.ROTATE : null;
    };

    if (reserveLeftButton) {
        container.addEventListener('pointerdown', chooseLeftButton, { capture: true });
    }

    /*
     * The middle button orbits, so it must not also do what the browser does with it.
     *
     * Chrome and Firefox on Windows and Linux start autoscroll on a middle press, which
     * would leave a scroll cursor stuck over the canvas for the whole of a drag.
     * OrbitControls does not stop it: it listens on pointerdown, and preventing that
     * does not suppress the mouse event the browser acts on. So the mouse event is what
     * is caught here.
     */
    const suppressAutoscroll = (event) => { if (event.button === 1) event.preventDefault(); };
    renderer.domElement.addEventListener('mousedown', suppressAutoscroll);

    /*
     * The camera on the keyboard: arrows orbit, shift+arrows pan, - and + zoom.
     *
     * OrbitControls has key handling of its own and it is not this one. `listenToKeyEvents`
     * puts pan on the bare arrows, rotate on the modified ones, and zoom on nothing at
     * all, so the camera is moved here instead -- by writing the position and letting
     * `update` reconcile, which is what resetView already does.
     *
     * The keys are the canvas's rather than the window's. An arrow means something in a
     * text field and in the trees and lists this app is mostly made of, and a handler on
     * the window would be left guessing which of those was asking; one on a canvas that
     * can hold focus never has to guess. Pressing in the view focuses it, so clicking on
     * the thing you want to steer is the whole of the ceremony.
     */
    renderer.domElement.tabIndex = 0;
    renderer.domElement.setAttribute('aria-label',
        `${label}. Arrow keys orbit, shift with arrow keys pans, minus and plus zoom.`);

    const focusOnPress = () => renderer.domElement.focus({ preventScroll: true });
    renderer.domElement.addEventListener('pointerdown', focusOnPress);

    /** Where the camera stands relative to what it looks at, which every key move works on. */
    const cameraOffset = () => camera.position.clone().sub(controls.target);

    function orbitBy(theta, phi) {
        const spherical = new THREE.Spherical().setFromVector3(cameraOffset());

        spherical.theta += theta;
        spherical.phi = Math.min(
            Math.max(spherical.phi + phi, controls.minPolarAngle + MIN_POLAR),
            controls.maxPolarAngle);

        camera.position.copy(controls.target).add(new THREE.Vector3().setFromSpherical(spherical));
    }

    function dollyBy(factor) {
        const offset = cameraOffset();
        const distance = Math.min(
            Math.max(offset.length() * factor, controls.minDistance), controls.maxDistance);

        camera.position.copy(controls.target).add(offset.setLength(distance));
    }

    /**
     * Pan across the screen rather than the world.
     *
     * Right is the camera's right and up is its up, so which way a key shifts the view
     * does not depend on where the camera has been orbited to. The eye and what it looks
     * at move together: moving only the eye would swing the view, which is orbiting.
     */
    function panBy(right, up) {
        camera.updateMatrixWorld();

        const step = cameraOffset().length() * KEY_PAN;
        const move = new THREE.Vector3()
            .setFromMatrixColumn(camera.matrixWorld, 0)
            .multiplyScalar(right * step)
            .add(new THREE.Vector3()
                .setFromMatrixColumn(camera.matrixWorld, 1)
                .multiplyScalar(up * step));

        camera.position.add(move);
        controls.target.add(move);
    }

    /*
     * An arrow moves the camera the way it points -- left orbits leftwards, up climbs --
     * so the model appears to swing the other way. That is the direction OrbitControls'
     * own keys take and the one every other orbit view takes with them.
     */
    function onKeyDown(event) {
        // A key with ctrl, meta or alt on it belongs to the browser or to the OS.
        if (event.ctrlKey || event.metaKey || event.altKey) return;

        const pans = event.shiftKey;

        switch (event.key) {
            case 'ArrowLeft': pans ? panBy(-1, 0) : orbitBy(-KEY_ORBIT, 0); break;
            case 'ArrowRight': pans ? panBy(1, 0) : orbitBy(KEY_ORBIT, 0); break;
            case 'ArrowUp': pans ? panBy(0, 1) : orbitBy(0, -KEY_ORBIT); break;
            case 'ArrowDown': pans ? panBy(0, -1) : orbitBy(0, KEY_ORBIT); break;

            // Shift is not consulted here: + is a shifted = on most layouts, and _ a
            // shifted -, so both spellings of each key mean the same zoom.
            case '-': case '_': dollyBy(KEY_ZOOM); break;
            case '=': case '+': dollyBy(1 / KEY_ZOOM); break;

            default: return;
        }

        // Only now that a key is known to be the camera's: an arrow this did not use is
        // still the page's to scroll with.
        event.preventDefault();
        controls.update();
        invalidate();
    }

    renderer.domElement.addEventListener('keydown', onKeyDown);

    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();

    let frame = null;

    /* ---------------------------------------------------------------- */

    function resize() {
        const width = container.clientWidth || 1;
        const height = container.clientHeight || 1;

        renderer.setSize(width, height, false);
        camera.aspect = width / height;
        camera.updateProjectionMatrix();
        draw();
    }

    const observer = new ResizeObserver(resize);
    observer.observe(container);

    function draw() {
        controls.update();
        renderer.render(scene, camera);
    }

    /** Draw on the next frame, so a run of edits costs one render rather than many. */
    function invalidate() {
        if (frame !== null) return;
        frame = requestAnimationFrame(() => {
            frame = null;
            draw();
        });
    }

    controls.addEventListener('change', invalidate);

    /**
     * The raycaster, aimed at where a pointer event happened.
     *
     * Handed back rather than used, because what to test against is the caller's: the
     * floorplan wants the nearer of two instanced meshes, and a model view wants the
     * marker under the pointer. Both want the ray set up the same way.
     */
    function rayFrom(event) {
        const rect = renderer.domElement.getBoundingClientRect();
        pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
        pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
        raycaster.setFromCamera(pointer, camera);
        return raycaster;
    }

    /**
     * A point in the scene as a place on the page, for putting an HTML label over it.
     *
     * Null when the point is behind the camera, which is a label that should not be drawn
     * rather than one to draw off screen.
     */
    function project(x, y, z) {
        const rect = renderer.domElement.getBoundingClientRect();
        const point = new THREE.Vector3(x, y, z).project(camera);

        if (point.z > 1) return null;

        return {
            left: rect.left + ((point.x + 1) / 2) * rect.width,
            top: rect.top + ((-point.y + 1) / 2) * rect.height,
        };
    }

    /** Put the camera back where it started, for a "reset view" control. */
    function resetView() {
        camera.position.set(...eye);
        controls.target.set(...target);
        controls.update();
        invalidate();
    }

    /**
     * What the caller wants let go of, run in the middle of `dispose`.
     *
     * The order is the reason this exists rather than the caller simply calling its own
     * teardown before or after. Everything that could draw is stopped first -- the
     * observer, the pending frame, the controls -- so nothing renders a scene whose
     * geometry is being disposed underneath it; the renderer and its canvas go last,
     * because they are what the disposed resources belong to.
     */
    const teardown = [];
    const onDispose = (callback) => teardown.push(callback);

    function dispose() {
        observer.disconnect();
        if (frame !== null) cancelAnimationFrame(frame);
        controls.dispose();
        renderer.domElement.removeEventListener('mousedown', suppressAutoscroll);
        renderer.domElement.removeEventListener('pointerdown', focusOnPress);
        renderer.domElement.removeEventListener('keydown', onKeyDown);

        // This one is not on the canvas, so it does not go when the canvas does.
        if (reserveLeftButton) {
            container.removeEventListener('pointerdown', chooseLeftButton, { capture: true });
        }

        for (const callback of teardown) callback();

        renderer.dispose();
        renderer.domElement.remove();
    }

    return {
        THREE, scene, camera, controls, renderer, raycaster,
        draw, invalidate, resize, rayFrom, project, resetView, onDispose, dispose,
        get canvas() { return renderer.domElement; },
    };
}

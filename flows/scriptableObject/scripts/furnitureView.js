/**
 * The furniture creator's 3D pane: one piece of furniture, and what sits on it.
 *
 * Built on `core/viewer3d.js`, which owns the camera, the controls and the canvas. What is
 * here is the content -- a footprint, a box where the model would be, and a marker per
 * sub-object -- and the one question the view answers back, which is what the pointer is
 * over.
 *
 * ## What is real and what is not
 *
 * The footprint and the sub-object positions are the game's own numbers. The box is not:
 * a shipped preset's model is a Unity `GameObject` in an asset bundle this app cannot
 * open, so what is drawn is a box the size of the class's footprint. It is scaffolding to
 * read positions against, and it is drawn as a wireframe rather than a solid so that it
 * cannot be mistaken for the model -- an author who thinks they are looking at the desk
 * will read the lamp as being in the wrong place.
 *
 * ## Metres, not nodes
 *
 * Everything here is in metres: sub-object positions are, and a node is 1.8 of them. That
 * is the whole reason `viewer3d.js` takes its distances as options -- the floorplan's near
 * plane of half a metre would cut through a chair.
 */
import {
    inSceneSpace, fromSceneSpace, proxyBox, footprintNode, NODE_METRES,
} from './furnitureModel.js';

/**
 * Where the camera starts: off one corner, a little above, looking at waist height.
 *
 * Read as an offset from whatever is being framed rather than as a place in the world --
 * see `frameOn`, which is where the piece it is framing turns out not to be at the origin.
 */
const EYE = [2.6, 2.0, 3.4];
const TARGET = [0, 0.7, 0];

/** How far back that leaves it, which is the closest it is ever put. */
const BASE_DISTANCE = Math.hypot(EYE[0] - TARGET[0], EYE[1] - TARGET[1], EYE[2] - TARGET[2]);

/** Room around a piece that has to be backed away from, as a fraction of what fits. */
const MARGIN = 1.15;

/**
 * A sub-object marker, in metres.
 *
 * Small enough not to hide what it sits on, large enough to hit with a pointer. Drawn as a
 * box with a spike out of its front, because a marker that is only a dot cannot show which
 * way it is turned -- and which way it is turned is half of what this pane exists to show.
 */
const MARKER = 0.09;
const MARKER_NOSE = 0.16;

/**
 * An integrated interactable's marker, in metres.
 *
 * An octahedron rather than a box with a nose on it, and the difference is a claim rather
 * than a decoration. A sub-object states its own rotation and the nose is that rotation; an
 * integrated interactable states none -- it takes position *and* rotation from a controller
 * inside the prefab, and this app reads only the position (`controllersIn`). A marker with
 * a nose on it would be pointing somewhere nothing was read from.
 */
const INTERACTABLE_MARKER = 0.11;

const COLOUR = {
    proxy: 0x5a6472,
    footprint: 0x2c333d,
    marker: 0xc9d3e0,
    selected: 0xff9d3c,
    parented: 0x7a6a4a,
    model: 0x9aa5b1,
    interactable: 0x4fb3a5,
};

/**
 * Build the pane inside a container.
 *
 * Returns a controller rather than the scene, the way `createScene` does: what the modal
 * needs is "show this preset", "mark this sub-object", "let go", and nothing about how any
 * of that is drawn.
 */
export async function createFurnitureView(container) {
    const { createViewer } = await import('../../../core/viewer3d.js');

    const viewer = await createViewer(container, {
        eye: EYE,
        target: TARGET,
        near: 0.05,
        far: 100,
        minDistance: 0.4,
        maxDistance: 25,
        label: 'Furniture view',
    });

    const { THREE, scene, invalidate } = viewer;

    scene.add(new THREE.AmbientLight(0xffffff, 1.9));
    const sun = new THREE.DirectionalLight(0xffffff, 1.1);
    sun.position.set(1, 2, 1);
    scene.add(sun);

    /*
     * Three groups, emptied and refilled rather than rebuilt.
     *
     * A group per kind because they are shown and hidden independently: the parented
     * markers are off until an author asks for them, and the proxy goes when a real model
     * arrives. Everything in a group is disposed when it is emptied -- there is no pooling
     * here, because a preset change is a click rather than a pointer move and 31 markers
     * is the largest this ever gets.
     */
    const footprint = new THREE.Group();
    const proxy = new THREE.Group();
    const model = new THREE.Group();
    const markers = new THREE.Group();
    const interactables = new THREE.Group();
    scene.add(footprint, proxy, model, markers, interactables);

    // Shared by every marker, so a preset with 31 of them makes one material rather than
    // 31. Disposed once, at the end, which is why they are held here.
    const markerMaterial = new THREE.MeshLambertMaterial({ color: COLOUR.marker });
    const parentedMaterial = new THREE.MeshLambertMaterial({ color: COLOUR.parented });
    const selectedMaterial = new THREE.MeshLambertMaterial({ color: COLOUR.selected });
    const markerGeometry = new THREE.BoxGeometry(MARKER, MARKER, MARKER);
    const noseGeometry = new THREE.ConeGeometry(MARKER * 0.45, MARKER_NOSE, 8);

    const interactableMaterial = new THREE.MeshLambertMaterial({ color: COLOUR.interactable });
    const interactableGeometry = new THREE.OctahedronGeometry(INTERACTABLE_MARKER);

    // The same for the things drawn once per preset. `clear` lets go of geometry alone, so
    // anything a material is shared across has to outlive the group holding it.
    const footprintMaterial = new THREE.MeshBasicMaterial({ color: COLOUR.footprint });
    const proxyMaterial = new THREE.LineBasicMaterial({ color: COLOUR.proxy });

    // A mod's model is drawn solid and lit from both sides. `side: DoubleSide` because a
    // hand-authored `.obj` need not be wound consistently, and a model with half its faces
    // invisible reads as a broken import rather than as a winding problem.
    const modelMaterial = new THREE.MeshLambertMaterial({
        color: COLOUR.model,
        side: THREE.DoubleSide,
    });

    let selected = null;
    let selectedInteractable = null;
    let showParented = false;
    let preset = null;

    /** The prefab's controllers, which are where the interactable markers go. */
    let controllers = [];

    /*
     * The point the camera is pointed at, which is not the origin.
     *
     * The origin is the model's anchor node and a piece reaches away from it, so a 4x2 food
     * truck ends seven metres along +x -- a camera aimed at the origin looks at one corner
     * of it and leaves the rest off screen. `EYE` and `TARGET` are read as an offset from
     * whatever is framed rather than as places in the world.
     */
    let framed = [0, 0, 0];

    /* ---------------------------------------------------------------- */

    /** Empty a group, letting go of whatever it held. Materials are shared and stay. */
    function clear(group) {
        for (const child of [...group.children]) {
            group.remove(child);
            child.traverse((node) => node.geometry?.dispose?.());
        }
    }

    /**
     * The tiles the piece stands on, as a flat grid under it.
     *
     * Drawn from the class footprint rather than from a fixed square: a 4x2 piece on a
     * 1x1 pad would read as overhanging its slot, which is a thing the game would refuse
     * and this one does not.
     */
    function drawFootprint(box) {
        clear(footprint);
        if (!box) return;

        const [across, deep] = box.tiles;

        // Counted down from the anchor, which is the piece's front-right node: the body
        // reaches into −x and −y of the frame a class writes its rules in. Same tiles the
        // placement diagram shades, named the same way, so the two halves of the pane can be
        // read against each other.
        for (let x = 0; x > -across; x--) {
            for (let y = 0; y > -deep; y--) {
                const geometry = new THREE.PlaneGeometry(NODE_METRES * 0.98, NODE_METRES * 0.98);
                const tile = new THREE.Mesh(geometry, footprintMaterial);

                tile.rotation.x = -Math.PI / 2;

                // The piece stands with its origin on the anchor tile, so the grid grows
                // away from it rather than being centred on it -- see `footprintNode`,
                // which is where that reading is set down and where the evidence for it is.
                tile.position.set(...footprintNode(x, y));

                footprint.add(tile);
            }
        }
    }

    /** The box the model would fill, as a wireframe. Never mistaken for the model. */
    function drawProxy(box) {
        clear(proxy);
        if (!box) return;

        const geometry = new THREE.BoxGeometry(box.width, box.height, box.depth);
        const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geometry), proxyMaterial);

        // Over the middle of the footprint, which is a node or more from the origin for
        // anything wider than one. Standing it on the origin is the same mistake as
        // centring the tiles there, and looks the same: a desk drawn beside its own load.
        edges.position.set(box.centre[0], box.height / 2, box.centre[2]);
        proxy.add(edges);

        // EdgesGeometry copies what it needs; the box itself is not added to the scene.
        geometry.dispose();
    }

    /**
     * A mod's own model, as `readModel` hands it back.
     *
     * Drawn instead of the proxy rather than beside it: the box is scaffolding for reading
     * positions against, and once there is a real shape to read them against the
     * scaffolding is in the way.
     *
     * Normals are computed where the file gave none, which is what an `.obj` written by
     * hand or by a converter often is. Doing it here rather than accepting flat shading
     * means a model without normals arrives lit rather than as a silhouette.
     */
    function drawModel(loaded) {
        clear(model);
        if (!loaded?.meshes?.length) return;

        for (const mesh of loaded.meshes) {
            const geometry = new THREE.BufferGeometry();
            const { positions, normals, uvs, indices } = mesh.geometry;

            geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
            if (uvs) geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
            geometry.setIndex(indices);

            if (normals) geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
            else geometry.computeVertexNormals();

            const drawn = new THREE.Mesh(geometry, modelMaterial);

            // The offset the prefab puts the mesh at, mirrored the same way everything
            // else here is -- it is a position in the game's space like any other.
            drawn.position.set(-(mesh.offset?.[0] ?? 0), mesh.offset?.[1] ?? 0, mesh.offset?.[2] ?? 0);

            model.add(drawn);
        }
    }

    /**
     * A marker per sub-object, turned the way the game turns it.
     *
     * The parented ones are drawn only when asked for, and in a different colour, because
     * they are not where they appear to be -- their position is relative to a transform
     * inside the model. Showing them at the root is a deliberate approximation and the
     * colour is what stops it reading as a measurement.
     */
    function drawMarkers() {
        clear(markers);
        if (!preset) return;

        const entries = [
            ...preset.placed.map((sub, index) => ({ sub, index, parented: false })),
            ...(showParented
                ? preset.parented.map((sub, index) => ({ sub, index, parented: true }))
                : []),
        ];

        for (const entry of entries) {
            const place = inSceneSpace(entry.sub);
            const chosen = entry.parented ? parentedMaterial : markerMaterial;

            const group = new THREE.Group();
            const body = new THREE.Mesh(markerGeometry, chosen);
            const nose = new THREE.Mesh(noseGeometry, chosen);

            // Out of the front face and pointing away from it. A cone points up its own
            // +y, so it is tipped a quarter turn to lie along +z first.
            nose.rotation.x = Math.PI / 2;
            nose.position.z = MARKER / 2 + MARKER_NOSE / 2;

            group.add(body, nose);
            group.position.set(...place.position);
            group.rotation.set(...place.rotation, place.order);

            // What a hit test reports back. Held on the group rather than looked up by
            // position, because two sub-objects may sit at the same point.
            group.userData.subObject = entry;

            markers.add(group);
        }

        paintSelection();
    }

    /**
     * A marker per integrated interactable, where the prefab's controller puts it.
     *
     * Only for entries the prefab can actually place. An entry paired to `none` creates
     * nothing, and one naming a controller the prefab has not got is created at the model's
     * origin by a code path that logs about it -- drawing either would put a marker
     * somewhere as though it had been measured, when what happened is that nothing was
     * found. The list is where both are reported.
     *
     * No rotation, for the reason `INTERACTABLE_MARKER` gives.
     */
    function drawInteractables() {
        clear(interactables);
        if (!preset) return;

        const byId = new Map(controllers.map((controller) => [controller.id, controller]));

        (preset.interactables ?? []).forEach((entry, index) => {
            const controller = byId.get(entry.controller);
            if (!controller) return;

            const marker = new THREE.Mesh(interactableGeometry, interactableMaterial);

            // Mirrored on x exactly as `drawModel` mirrors a mesh offset: it is a position
            // in the game's space like any other, and this scene is the other handedness.
            marker.position.set(
                -(controller.offset?.[0] ?? 0),
                controller.offset?.[1] ?? 0,
                controller.offset?.[2] ?? 0);

            marker.userData.interactable = { index, id: entry.controller };
            interactables.add(marker);
        });

        paintSelection();
    }

    /** Recolour rather than rebuild: selecting is a click, and rebuilding loses nothing. */
    function paintSelection() {
        for (const group of markers.children) {
            const entry = group.userData.subObject;
            const isSelected = selected
                && selected.index === entry.index
                && selected.parented === entry.parented;

            const material = isSelected
                ? selectedMaterial
                : entry.parented ? parentedMaterial : markerMaterial;

            for (const child of group.children) child.material = material;
        }

        for (const marker of interactables.children) {
            marker.material = marker.userData.interactable.index === selectedInteractable
                ? selectedMaterial
                : interactableMaterial;
        }
    }

    /* ---------------------------------------------------------------- */

    /**
     * Show a preset, as `describePreset` returns it. Null clears the view.
     *
     * `loaded` is the mod's own model where there is one -- `readModel`'s result. The box
     * is drawn only when there is not: a preset naming a prefab whose files are missing
     * gets neither, because a proxy where a model was expected reads as the model being
     * wrong rather than absent, and the pane says which file it could not find instead.
     */
    function show(next, loaded = null) {
        preset = next;
        selected = null;
        selectedInteractable = null;

        // The prefab's, where one was read. Held rather than passed into `drawInteractables`
        // because `select` repaints without being handed the model again.
        controllers = loaded?.controllers ?? [];

        const box = proxyBox(next);
        const hasModel = !!loaded?.meshes?.length;

        drawFootprint(box);
        drawProxy(hasModel || loaded?.missing ? null : box);
        drawModel(loaded);
        drawMarkers();
        drawInteractables();
        frameOn(box);
        invalidate();
    }

    /**
     * Bring the camera over the middle of the footprint, at a distance the piece fits in.
     *
     * Only when that point moves, which is only when the footprint changes shape -- the
     * centre of a block of nodes states its size, so two presets that frame the same are
     * the same size. `show` runs on every edit, a dragged marker and a changed field
     * included, and a camera that re-framed on each of those would pull itself out from
     * under whoever was orbiting it.
     *
     * The angle is kept and only the point and the distance change. Whoever has swung
     * around to the back of a piece asked to be there, and opening the next one is not them
     * asking to leave; the distance is not theirs in the same way, because a 4x2 food truck
     * seen from where a chair was seen is a wall of wireframe.
     */
    function frameOn(box) {
        const centre = box?.centre ?? [0, 0, 0];
        if (centre[0] === framed[0] && centre[2] === framed[2]) return;

        framed = centre;

        const heading = viewer.camera.position.clone().sub(viewer.controls.target).normalize();

        viewer.controls.target.set(framed[0] + TARGET[0], TARGET[1], framed[2] + TARGET[2]);
        viewer.camera.position.copy(viewer.controls.target)
            .addScaledVector(heading, distanceFor(box));
    }

    /**
     * How far back a piece has to be seen from, never nearer than a one-node piece is.
     *
     * The widest of the three dimensions against the camera's own vertical angle, which is
     * the tighter of the two it has -- a pane is wider than it is tall, so a piece that fits
     * up and down fits across. `BASE_DISTANCE` is the floor rather than the answer, so the
     * 210 classes that are a single node are framed exactly as they were.
     */
    function distanceFor(box) {
        if (!box) return BASE_DISTANCE;

        const span = Math.max(box.width, box.depth, box.height);
        const half = (viewer.camera.fov / 2) * (Math.PI / 180);

        return Math.max(BASE_DISTANCE, (span / 2) / Math.tan(half) * MARGIN);
    }

    /** Back to where the camera started, about whatever is framed rather than the origin. */
    function resetView() {
        const box = proxyBox(preset);

        viewer.controls.target.set(framed[0] + TARGET[0], TARGET[1], framed[2] + TARGET[2]);
        viewer.camera.position.copy(viewer.controls.target).add(
            new THREE.Vector3(EYE[0] - TARGET[0], EYE[1] - TARGET[1], EYE[2] - TARGET[2])
                .setLength(distanceFor(box)));

        invalidate();
    }

    /** Mark one sub-object, or none. Identified the way a hit reports it. */
    function select(entry) {
        selected = entry;
        paintSelection();
        invalidate();
    }

    /**
     * Mark one integrated interactable by its index in the preset's list, or none.
     *
     * Its own call rather than a second shape `select` takes, for the reason the pane holds
     * the two selections apart: what can be done with either differs -- a sub-object gets
     * the drag handles and this does not -- and one function taking both would be one place
     * that has to keep asking which it was given.
     */
    function selectInteractable(index) {
        selectedInteractable = index;
        paintSelection();
        invalidate();
    }

    /** Show or hide the sub-objects whose position this view cannot vouch for. */
    function setParentedVisible(visible) {
        showParented = visible;
        drawMarkers();
        invalidate();
    }

    /*
     * The drag handles, attached to whichever marker is selected.
     *
     * Built on first use rather than up front: it is another addon to fetch, and a pane
     * opened to look at something rather than to change it never needs one.
     *
     * Orbiting is switched off for the length of a drag. Both are on the left button, and
     * without this a drag that started on a handle would also swing the camera -- the same
     * collision the floorplan solves the other way round, by withholding the button from
     * the camera because the tools own it.
     */
    let gizmo = null;
    let onMoved = null;

    async function ensureGizmo() {
        if (gizmo) return gizmo;

        const { TransformControls } = await import('three/addons/controls/TransformControls.js');
        gizmo = new TransformControls(viewer.camera, viewer.canvas);

        gizmo.addEventListener('dragging-changed', (event) => {
            viewer.controls.enabled = !event.value;
        });

        gizmo.addEventListener('objectChange', () => {
            const group = gizmo.object;
            if (!group || !onMoved) return;

            // Back into the game's numbers before anything else sees them. The scene's
            // coordinates are this file's business and nothing outside it should have to
            // know which way round they are.
            const place = fromSceneSpace(
                [group.position.x, group.position.y, group.position.z],
                [group.rotation.x, group.rotation.y, group.rotation.z]);

            onMoved(group.userData.subObject, place);
        });

        // Since r169 the controls are steered through a helper object, which is what goes
        // in the scene; older builds are the control itself. Both are handled because the
        // pinned version is not the only one this will ever run against.
        scene.add(gizmo.getHelper ? gizmo.getHelper() : gizmo);
        gizmo.setSize(0.6);

        return gizmo;
    }

    /**
     * Put the handles on the marked sub-object, or take them off.
     *
     * `mode` is 'translate' or 'rotate'. Two modes rather than one because a piece of
     * furniture is arranged by both, and a gizmo that only moves things makes turning one
     * a matter of typing numbers.
     */
    async function setDragging(entry, mode, moved) {
        onMoved = moved;

        if (!entry) {
            gizmo?.detach();
            invalidate();
            return;
        }

        const group = markers.children.find((child) => {
            const carried = child.userData.subObject;
            return carried.index === entry.index && carried.parented === entry.parented;
        });

        if (!group) {
            gizmo?.detach();
            invalidate();
            return;
        }

        const controls = await ensureGizmo();
        controls.setMode(mode === 'rotate' ? 'rotate' : 'translate');
        controls.attach(group);
        invalidate();
    }

    /** Which sub-object is under a pointer event, or null. */
    function markerAt(event) {
        const hit = viewer.rayFrom(event).intersectObject(markers, true)[0];
        if (!hit) return null;

        // The mesh hit is a child; what carries the identity is the group it is in.
        return hit.object.parent?.userData?.subObject ?? null;
    }

    /**
     * Which integrated interactable is under a pointer event, or null.
     *
     * A sibling of `markerAt` rather than a second thing it can return, so the drag path --
     * which asks `markerAt` for something it can attach handles to -- keeps the one shape it
     * has always had. A caller wanting both asks both, in the order it cares about.
     *
     * The marker is a mesh rather than a group, so the identity is on the object hit.
     */
    function interactableAt(event) {
        const hit = viewer.rayFrom(event).intersectObject(interactables, true)[0];
        return hit?.object?.userData?.interactable ?? null;
    }

    viewer.onDispose(() => {
        // Before the markers go: the gizmo holds a reference to whichever one it is on,
        // and detaching after they are disposed leaves it pointing at freed geometry.
        gizmo?.detach();
        gizmo?.dispose?.();

        for (const group of [footprint, proxy, model, markers, interactables]) clear(group);

        markerGeometry.dispose();
        noseGeometry.dispose();
        interactableGeometry.dispose();
        markerMaterial.dispose();
        parentedMaterial.dispose();
        selectedMaterial.dispose();
        interactableMaterial.dispose();
        footprintMaterial.dispose();
        proxyMaterial.dispose();
        modelMaterial.dispose();
    });

    viewer.resize();

    return {
        show, select, selectInteractable, setParentedVisible, markerAt, interactableAt,
        setDragging, resetView,
        resize: viewer.resize,
        dispose: viewer.dispose,
        get canvas() { return viewer.canvas; },
        _internals: { THREE, scene, footprint, proxy, model, markers, interactables, viewer },
    };
}

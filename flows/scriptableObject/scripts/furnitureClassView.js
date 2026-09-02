/**
 * The placement diagram: a class's rules drawn as the grid they are written on.
 *
 * DOM rather than a canvas, and 2D rather than in the model view. A rule is a tile and an
 * edge of a tile, which is a plan drawing; and the useful thing about it is the words on
 * it -- 17 wall tags, class names, a direction each -- which are what a canvas is worst at
 * and what a grid of elements is best at. It also means this half of the pane works
 * without WebGL, which the model half cannot.
 *
 * ## Which way up
 *
 * `front` is up. Everything a class states is in the furniture's own frame, and the
 * generator tries all four quarter turns of it -- so this is one of four readings, and the
 * one the author wrote. The diagram says so out loud rather than leaving the reader to
 * wonder whether up is north.
 */
import {
    tilesOf, gridBounds, explainRule, explainBlock, explainWallCount, explainFootprint,
    DIRECTION_OFFSET, EDGES,
} from './furnitureClass.js';

/**
 * Draw a placement into a container.
 *
 * @param selected      the rule or block the editor is on, marked here
 * @param selectedTile  `[x, y]` of the marked tile, or null
 * @param extent        `modelExtent`'s answer, or null where there is no model to measure
 * @param onSelect      called with a rule or block when one is clicked
 * @param onSelectTile  called with `[x, y]` when a tile is
 * @param onAdd         called with `[x, y]` when a tile's + is
 */
export function drawPlacement(container, placement, {
    selected = null, selectedTile = null, extent = null,
    onSelect = null, onSelectTile = null, onAdd = null,
} = {}) {
    container.replaceChildren();
    if (!placement) return;

    const grid = document.createElement('div');
    grid.className = 'placement-grid';
    grid.setAttribute('role', 'grid');

    const bounds = gridBounds(placement, extent);
    grid.style.setProperty('--placement-columns', String(bounds.maxX - bounds.minX + 1));

    for (const tile of tilesOf(placement, extent)) {
        grid.append(drawTile(tile, { selected, selectedTile, onSelect, onSelectTile, onAdd }));
    }

    container.append(grid);

    // How big it is and which way it reaches, before anything about the rules. The shading
    // says three tiles are covered; it does not say which of them is the far end, which is
    // the question a 3x1 table is opened with.
    const footprint = explainFootprint(placement);
    if (footprint) container.append(note(footprint));

    // The one thing the grid cannot show, because it is about the room rather than about a
    // tile: a minimum distance from other classes has no offset to be drawn at.
    if (placement.away) {
        container.append(note(`Keeps at least ${placement.away.distance} nodes from `
            + `${placement.away.classes.join(', ')}. A diagonal step is about 1.8, so this is `
            + 'measured through the room rather than in tiles — which is why it is not on the '
            + 'grid.'));
    }

    const walls = explainWallCount(placement);
    if (walls) container.append(note(walls));
}

/**
 * One tile: what is on it, what is written on its edges, and the two controls that make it
 * a place to work rather than a picture.
 *
 * The edges are four elements inside the tile rather than borders on it, because an edge
 * carries a rule of its own that has to be clickable and coloured -- and because two
 * neighbouring tiles that each name the boundary between them are naming one wall from two
 * sides, which shared borders would draw as one mark and lose.
 *
 * ## Why the tile is a div and its label is a button
 *
 * The marks inside a tile are buttons, so the tile cannot be one -- nested buttons are
 * invalid and a screen reader is entitled to do anything at all with them. So selection is a
 * click handler on the div, which is the mouse path, and the label is a real button carrying
 * the same behaviour, which is the keyboard one. Both do exactly the same thing rather than
 * one being a lesser version of the other.
 */
function drawTile(tile, { selected, selectedTile, onSelect, onSelectTile, onAdd }) {
    const cell = document.createElement('div');
    cell.className = 'placement-tile';
    cell.setAttribute('role', 'gridcell');

    if (tile.covered) cell.classList.add('placement-tile-covered');
    if (tile.anchor) cell.classList.add('placement-tile-anchor');

    // Where the mesh reaches and the class does not. Not a rule being broken: the generator
    // decides placement from the declared size and never looks at the model, so this is a
    // piece that will be stood next to something and clip it.
    if (tile.overhang) cell.classList.add('placement-tile-overhang');

    const here = selectedTile && selectedTile[0] === tile.x && selectedTile[1] === tile.y;
    if (here) cell.classList.add('placement-tile-selected');

    if (onSelectTile) {
        // Only when the click was the tile's own. A mark inside it has its own handler and
        // its own meaning, and a tile that also swallowed those would unmark the rule the
        // author just picked.
        cell.addEventListener('click', (event) => {
            if (event.target === cell) onSelectTile([tile.x, tile.y]);
        });
    }

    // The edges first, so the rules written inside sit over them.
    for (const edge of EDGES) {
        const rules = tile.rules.filter((rule) => rule.kind === 'wall' && rule.dir === edge);
        const blocks = tile.blocks.filter((entry) => entry.dirs.includes(edge));

        if (!rules.length && !blocks.length) continue;
        cell.append(drawEdge(edge, rules, blocks, { selected, onSelect }));
    }

    // A rule naming a diagonal is about a corner, which is not one of the four edges. Drawn
    // as a mark in the corner it names rather than folded into a neighbouring edge, which
    // would put it on a boundary the rule does not mention.
    for (const rule of tile.rules) {
        if (rule.kind !== 'wall') continue;
        if (EDGES.includes(rule.dir) || rule.dir === 'none') continue;

        cell.append(drawCorner(rule, { selected, onSelect }));
    }

    cell.append(drawLabel(tile, here, onSelectTile));
    if (onAdd) cell.append(drawAdd(tile, onAdd));

    for (const rule of tile.rules) {
        if (rule.kind === 'node') cell.append(drawNodeRule(rule, { selected, onSelect }));
    }

    if (tile.weight) {
        const weight = document.createElement('span');
        weight.className = 'placement-weight';
        weight.textContent = `weight ${tile.weight.weight > 0 ? '+' : ''}${tile.weight.weight}`;
        weight.title = 'Changes how likely the generator is to choose this node, without '
            + 'deciding whether it may.';
        cell.append(weight);
    }

    return cell;
}

/** The tile's name, and the keyboard's way of marking it. */
function drawLabel(tile, here, onSelectTile) {
    const where = tile.anchor ? 'anchor' : `${tile.x}, ${tile.y}`;

    if (!onSelectTile) {
        const label = document.createElement('span');
        label.className = 'placement-tile-label';
        label.textContent = where;
        return label;
    }

    const label = document.createElement('button');
    label.type = 'button';
    label.className = 'placement-tile-label';
    label.textContent = where;

    label.setAttribute('aria-label', `Tile at ${tile.x}, ${tile.y}`
        + `${tile.anchor ? ', the anchor' : ''}`
        + `${tile.covered ? ', which the piece stands on' : ''}`
        + `${tile.overhang ? ', which its model overhangs onto' : ''}`);

    if (here) label.setAttribute('aria-current', 'true');
    label.addEventListener('click', () => onSelectTile([tile.x, tile.y]));

    return label;
}

/**
 * The + that puts a rule on this tile.
 *
 * Per tile rather than one button under the grid, because the offset is the thing that was
 * hardest to get right: a single Add put every rule on the anchor and left the author to
 * type the tile back out in two number fields, having just pointed at it.
 *
 * It makes a wall rule, which is the common case -- 233 of the 262 classes have one. The
 * editor's kind select is what turns it into an occupancy rule or a closed way out, so the
 * `+` does not have to be a menu.
 */
function drawAdd(tile, onAdd) {
    const element = document.createElement('button');
    element.type = 'button';
    element.className = 'placement-add';
    element.textContent = '+';

    element.title = `Put a rule on the tile at ${tile.x}, ${tile.y}`;
    element.setAttribute('aria-label', element.title);

    element.addEventListener('click', () => onAdd([tile.x, tile.y]));
    return element;
}

/**
 * A rule on one edge of one tile.
 *
 * Several rules can name one edge -- a `mustFeature` and a `cantFeature` on the same
 * boundary are a pair an author writes deliberately -- so this is one element carrying all
 * of them rather than one per rule, and its colour is the strongest thing any of them says.
 *
 * A closed way out is drawn on the same element for the same reason: it is about the
 * boundary between two tiles, which is what an edge is. Clicking it selects the rule if
 * there is one and the block if there is not -- an edge that was only blocked used to select
 * nothing at all, which read as the mark being decoration.
 */
function drawEdge(edge, rules, blocks, { selected, onSelect }) {
    const element = document.createElement('button');
    element.type = 'button';
    element.className = `placement-edge placement-edge-${edge}`;

    const must = rules.some((rule) => rule.gates && rule.must);
    const cant = rules.some((rule) => rule.gates && !rule.must);
    const scores = rules.some((rule) => !rule.gates);

    if (must) element.classList.add('placement-must');
    else if (cant) element.classList.add('placement-cant');
    else if (scores) element.classList.add('placement-score');
    if (blocks.length) element.classList.add('placement-blocked');
    if (rules.some((rule) => rule.unreadable)) element.classList.add('placement-unreadable');

    const subject = rules[0] ?? blocks[0] ?? null;
    if (selected && (rules.includes(selected) || blocks.includes(selected))) {
        element.setAttribute('aria-current', 'true');
    }

    element.textContent = rules.map((rule) => tagMark(rule)).join(' ') || '×';
    element.title = rules.map(explainRule).join('\n')
        || 'The way out of this tile in this direction is closed once the piece is here.';

    element.setAttribute('aria-label', element.title);
    if (onSelect) element.addEventListener('click', () => onSelect(subject));

    return element;
}

/** A rule naming a diagonal, drawn in the corner it names. */
function drawCorner(rule, { selected, onSelect }) {
    const [dx, dy] = DIRECTION_OFFSET[rule.dir] ?? [0, 0];

    const element = document.createElement('button');
    element.type = 'button';
    element.className = 'placement-corner';
    element.style.setProperty('--corner-x', dx > 0 ? '100%' : '0%');
    element.style.setProperty('--corner-y', dy > 0 ? '0%' : '100%');

    element.classList.add(rule.gates ? (rule.must ? 'placement-must' : 'placement-cant') : 'placement-score');
    if (selected === rule) element.setAttribute('aria-current', 'true');

    element.textContent = tagMark(rule);
    element.title = explainRule(rule);
    element.setAttribute('aria-label', element.title);
    if (onSelect) element.addEventListener('click', () => onSelect(rule));

    return element;
}

/** A rule about what is already standing on a tile. */
function drawNodeRule(rule, { selected, onSelect }) {
    const element = document.createElement('button');
    element.type = 'button';
    element.className = 'placement-node-rule';

    element.classList.add(rule.option === 'mustFeature' ? 'placement-must'
        : rule.option === 'cantFeature' ? 'placement-cant' : 'placement-score');

    if (selected === rule) element.setAttribute('aria-current', 'true');

    const what = rule.any ? 'anything' : rule.class ?? '?';
    element.textContent = `${rule.option === 'cantFeature' ? 'no ' : ''}${what}`;
    element.title = explainRule(rule);
    element.setAttribute('aria-label', element.title);
    if (onSelect) element.addEventListener('click', () => onSelect(rule));

    return element;
}

/**
 * The shortest thing that stands for a tag on a diagram.
 *
 * An abbreviation rather than the tag: `wallOrUpperVent` does not fit on an edge and
 * `entranceToRoomOfType` fits nowhere. What each one means is on the title and in the
 * editor, so this only has to be distinguishable at a glance.
 */
const MARKS = {
    nothing: 'open',
    wall: 'wall',
    window: 'win',
    windowLarge: 'WIN',
    anyWindow: 'win?',
    entrance: 'door',
    entranceDoorOnly: 'door!',
    entraceDivider: 'div',
    entranceToRoomOfType: 'door→',
    addressEntrance: 'front',
    ventUpper: 'vent↑',
    ventLower: 'vent↓',
    ventTop: 'vent^',
    wallOrUpperVent: 'wall/v',
    fence: 'fence',
    securityDoorDivider: 'sec',
    lightswitch: 'switch',
};

const tagMark = (rule) => `${rule.gates && !rule.must ? '¬' : ''}${MARKS[rule.tag] ?? rule.tag}`;

function note(text) {
    const element = document.createElement('small');
    element.className = 'room-creator-note room-creator-note-plain';
    element.textContent = text;
    return element;
}

/** Every blocked-access entry as a sentence, for the list under the grid. */
export function blockNotes(placement) {
    return (placement?.blocks ?? []).map(explainBlock);
}

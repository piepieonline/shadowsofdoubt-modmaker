/**
 * The menus that hang off a flow's bar: the building list on the left of one, Tools on
 * the right of all three.
 *
 * A `<details>` is the whole of a menu except for the one thing a menu has to do, which
 * is shut when the click goes somewhere else. That is what this is: one listener on the
 * document, for every menu on the page.
 *
 * Bound once by the shell rather than by each flow. The menus come and go with the
 * flow's markup -- switching editor replaces every one of them -- and this looks up what
 * is open at the moment of the click, so there is nothing to rebind when it does.
 *
 * What a menu holds is the flow's. This only decides when one is shut, and the markup
 * says which of the things inside it are a way out: a click on anything else is left
 * alone, because opening a category in a list of files should not close the list.
 */

const MENU = 'details.browse';

/** Marks something in a menu that is picked *from* it rather than done inside it. */
const ITEM = '[data-menu-item]';

const openMenus = () => document.querySelectorAll(`${MENU}[open]`);

let bound = false;

export function initBarMenus() {
    if (bound) return;
    bound = true;

    document.addEventListener('click', (event) => {
        for (const menu of openMenus()) {
            // A click on a closed menu's own summary is not seen here as an open one:
            // a `<details>` toggles after the event has finished being dispatched, so
            // what this walks is what was open before the click.
            const inside = menu.contains(event.target);
            if (!inside || event.target.closest?.(ITEM)) menu.removeAttribute('open');
        }
    });
}

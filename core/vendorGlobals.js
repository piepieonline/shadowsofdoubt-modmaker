/**
 * The third-party libraries that arrive as globals, and why they still do.
 *
 * These used to be `<script src>` tags in index.html, which is what made them global. The
 * bundler removes that, so the globals are published here instead -- deliberately, and in
 * one place, rather than being a property of how a file happened to be loaded.
 *
 * They stay global because their consumers expect them to be. `jsonpatch` is read by
 * core/document.js, core/persistence.js, core/patchFormat.js and core/arrayControls.js,
 * all of which say so in their own comments; `jsonTree` by half the tree editor; jQuery by
 * select2, which is a plugin and has no other way to be reached. Converting those call
 * sites to imports is a worthwhile change and a much larger one -- doing it here would
 * have made the build migration a rewrite as well.
 *
 * Imported for its side effect, first, by main.js. Everything downstream can then assume
 * the globals exist, exactly as it could when the tags were in the markup.
 */
import jQuery from 'jquery';
import select2 from 'select2';
import * as idbKeyval from 'idb-keyval';
import * as jsonpatch from 'fast-json-patch';
import jsonTree from '../libs/jsonTree/jsonTree.js';


/**
 * select2 does not install itself under a bundler.
 *
 * Its UMD wrapper picks the CommonJS branch here and exports a factory rather than
 * registering the plugin, so `import 'select2'` alone leaves `$.fn.select2` undefined and
 * the ScriptableObject flow's reference picker silently renders as a bare `<select>`.
 * Calling the factory is what the browser-global branch would have done for us.
 *
 * jQuery goes on the window first because the factory reaches for it there when the second
 * argument is absent, and because select2's own language files look it up globally later.
 */
window.jQuery = jQuery;
window.$ = jQuery;
select2(window, jQuery);

window.idbKeyval = idbKeyval;
window.jsonpatch = jsonpatch;
window.jsonTree = jsonTree;

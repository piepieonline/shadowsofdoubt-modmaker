/** Small DOM construction helpers, shared by both flows. */

export function fastElement(tag, DOM_class) {
	let ele = document.createElement(tag);
	if (DOM_class) ele.className = DOM_class;
	return ele;
}

export function fastDiv(DOM_class) {
	if (DOM_class) {
		return fastElement("div", DOM_class)
	} else {
		return fastElement("div")
	}
}

/**
 * Replace a <select>'s options with the given list of strings.
 * `select` was an implicit global in the original; declared here because modules
 * are strict mode and an undeclared assignment would throw.
 */
export function updateSelect(id, options) {
    const select = document.getElementById(id);
    select.innerHTML = '';

    options.forEach(option => {
        var opt = document.createElement('option');
        opt.value = option;
        opt.innerHTML = option;
        select.appendChild(opt);
    });
}

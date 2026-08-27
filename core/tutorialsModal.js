/**
 * The tutorials list.
 *
 * One place to find the guided walkthroughs, opened from the header. The steps of each
 * one live in tutorials/<id>.json and are fetched only when it is started; this list is
 * the index, so opening the modal does not mean loading every tutorial to name it.
 */
import { startTutorial } from './tutorialRunner.js';

const MODAL = '#tutorials-modal';

/** Every tutorial the app offers, in the order they are listed. */
export const TUTORIALS = [
    {
        id: 'theftgonewrong',
        title: 'Theft Gone Wrong',
        summary: 'Build a murder case from scratch: a robbery that ends in a body.',
    },
];

function render() {
    const list = document.querySelector('#tutorials-list');
    list.replaceChildren();

    for (const tutorial of TUTORIALS) {
        const row = document.createElement('li');
        row.className = 'tutorial-row';
        row.dataset.tutorial = tutorial.id;

        const button = document.createElement('button');
        button.className = 'secondary';
        button.dataset.startTutorial = tutorial.id;
        // Out of the way first: the first step points at a control in the header, which
        // this modal is sitting on top of.
        button.addEventListener('click', async () => {
            closeTutorialsModal();
            await startTutorial(tutorial.id);
        });

        const title = document.createElement('strong');
        title.textContent = tutorial.title;

        const summary = document.createElement('small');
        summary.textContent = tutorial.summary;

        button.append(title, document.createElement('br'), summary);
        row.append(button);
        list.appendChild(row);
    }
}

export function openTutorialsModal() {
    render();
    document.querySelector(MODAL).setAttribute('open', '');
}

export function closeTutorialsModal() {
    document.querySelector(MODAL).removeAttribute('open');
}

/** Bind the shell's own controls. Called once, not per flow. */
export function initTutorialsModal() {
    document.querySelector('#tutorials-open').addEventListener('click', openTutorialsModal);
    document.querySelector('#tutorials-close').addEventListener('click', closeTutorialsModal);
}

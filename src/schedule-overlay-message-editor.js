let quillInstance = null;
let quillConstructor = null;
let quillLoadPromise = null;
let onChangeCallback = null;
let ignoreNextChange = false;
let overlayEditorShortcutUnlisten = null;

const OVERLAY_EDITOR_SHORTCUT_FORMATS = {
    b: 'bold',
    i: 'italic',
    u: 'underline',
};

function makeOverlayFormatKeyboardBinding(format) {
    return {
        key: format[0],
        shortKey: true,
        handler(range, context) {
            this.quill.format(format, !context.format[format], quillConstructor.sources.USER);
            this.quill.getModule('toolbar')?.update(range);
            return false;
        },
    };
}

function isOverlayEditorFocused() {
    if (!quillInstance?.root) return false;
    const modal = document.getElementById('schedule-overlay-customise-modal');
    if (!modal || modal.classList.contains('hidden')) return false;
    const active = document.activeElement;
    return active === quillInstance.root || quillInstance.root.contains(active);
}

function toggleOverlayEditorFormat(format) {
    if (!quillInstance) return;
    const range = quillInstance.getSelection(true);
    if (!range) return;
    const current = quillInstance.getFormat(range);
    quillInstance.format(format, !current[format], Quill.sources.USER);
    quillInstance.getModule('toolbar')?.update(range);
}

function bindOverlayEditorShortcutFallback() {
    if (overlayEditorShortcutUnlisten) return;

    const onKeyDown = (event) => {
        if (!isOverlayEditorFocused()) return;
        if (!(event.metaKey || event.ctrlKey) || event.altKey) return;

        const format = OVERLAY_EDITOR_SHORTCUT_FORMATS[event.key.toLowerCase()];
        if (!format) return;

        event.preventDefault();
        event.stopPropagation();
        toggleOverlayEditorFormat(format);
    };

    document.addEventListener('keydown', onKeyDown, true);
    overlayEditorShortcutUnlisten = () => {
        document.removeEventListener('keydown', onKeyDown, true);
        overlayEditorShortcutUnlisten = null;
    };
}

function unbindOverlayEditorShortcutFallback() {
    overlayEditorShortcutUnlisten?.();
}

function normalizeEditorHtml(value) {
    return String(value || '').replace(/&nbsp;/g, ' ');
}

export function isOverlayMessageEmpty(html) {
    if (!html?.trim()) return true;
    const stripped = html
        .replace(/<[^>]*>/g, '')
        .replace(/&nbsp;/g, ' ')
        .trim();
    return !stripped;
}

export function plainTextToOverlayMessageHtml(text) {
    const escaped = escapeHtmlForOverlay(text);
    return escaped
        .split(/\n\n+/)
        .map((paragraph) => `<p>${paragraph.replace(/\n/g, '<br>')}</p>`)
        .join('');
}

export function normalizeStoredOverlayMessage(message) {
    if (!message?.trim()) return null;
    const trimmed = message.trim();
    if (/<[a-z][^>]*>/i.test(trimmed)) return trimmed;
    return plainTextToOverlayMessageHtml(trimmed);
}

export function escapeHtmlForOverlay(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

export function sanitizeOverlayMessageHtml(html) {
    if (!html) return '';
    const allowedTags = new Set([
        'P', 'BR', 'STRONG', 'B', 'EM', 'I', 'U', 'S', 'STRIKE', 'UL', 'OL', 'LI', 'A',
    ]);
    const doc = new DOMParser().parseFromString(`<div>${html}</div>`, 'text/html');
    const root = doc.body.firstElementChild;
    if (!root) return '';

    function sanitizeNode(node) {
        Array.from(node.childNodes).forEach((child) => {
            if (child.nodeType === Node.TEXT_NODE) return;

            if (child.nodeType !== Node.ELEMENT_NODE) {
                child.remove();
                return;
            }

            if (!allowedTags.has(child.tagName)) {
                while (child.firstChild) {
                    child.parentNode.insertBefore(child.firstChild, child);
                }
                child.remove();
                return;
            }

            Array.from(child.attributes).forEach((attr) => {
                if (child.tagName === 'A' && attr.name === 'href') {
                    const href = attr.value.trim();
                    if (!/^(https?:|mailto:|tel:|#)/i.test(href)) {
                        child.removeAttribute('href');
                    }
                    return;
                }
                child.removeAttribute(attr.name);
            });

            sanitizeNode(child);
        });
    }

    sanitizeNode(root);
    return root.innerHTML;
}

async function loadQuill() {
    if (!quillLoadPromise) {
        quillLoadPromise = Promise.all([
            import('quill'),
            import('quill/dist/quill.snow.css'),
        ]).then(([module]) => {
            quillConstructor = module.default;
            return quillConstructor;
        });
    }
    return quillLoadPromise;
}

export async function initScheduleOverlayMessageEditor(containerEl, { onChange, placeholder } = {}) {
    if (quillInstance) return quillInstance;
    onChangeCallback = onChange;

    const Quill = await loadQuill();

    quillInstance = new Quill(containerEl, {
        theme: 'snow',
        placeholder: placeholder || '',
        modules: {
            toolbar: {
                container: [
                    ['bold', 'italic', 'underline', 'strike'],
                    [{ list: 'ordered' }, { list: 'bullet' }],
                    ['link'],
                    ['insertApps', 'insertLetsGo'],
                ],
                handlers: {
                    insertApps: () => insertScheduleOverlayEditorTag('{apps}'),
                    insertLetsGo: () => insertScheduleOverlayEditorTag('{letsGo}'),
                },
            },
            keyboard: {
                bindings: {
                    bold: makeOverlayFormatKeyboardBinding('bold'),
                    italic: makeOverlayFormatKeyboardBinding('italic'),
                    underline: makeOverlayFormatKeyboardBinding('underline'),
                },
            },
        },
        formats: ['bold', 'italic', 'underline', 'strike', 'list', 'link'],
    });

    quillInstance.getModule('toolbar')?.container
        ?.querySelector('.ql-insertApps')
        ?.setAttribute('data-label', '{apps}');
    quillInstance.getModule('toolbar')?.container
        ?.querySelector('.ql-insertLetsGo')
        ?.setAttribute('data-label', '{letsGo}');

    quillInstance.on('text-change', () => {
        if (ignoreNextChange) {
            ignoreNextChange = false;
            return;
        }
        onChangeCallback?.(getScheduleOverlayMessageEditorHtml());
    });

    bindOverlayEditorShortcutFallback();

    return quillInstance;
}

export function insertScheduleOverlayEditorTag(tag) {
    if (!quillInstance) return;
    const range = quillInstance.getSelection(true);
    const index = range ? range.index : Math.max(0, quillInstance.getLength() - 1);
    quillInstance.insertText(index, tag, 'user');
    quillInstance.setSelection(index + tag.length);
}

export function destroyScheduleOverlayMessageEditor() {
    if (!quillInstance) return;
    unbindOverlayEditorShortcutFallback();
    quillInstance = null;
    onChangeCallback = null;
    ignoreNextChange = false;
}

export function setScheduleOverlayMessageEditorHtml(html, { silent = false } = {}) {
    if (!quillInstance) return;
    if (silent) ignoreNextChange = true;

    quillInstance.setText('');
    const normalized = normalizeStoredOverlayMessage(html);
    if (normalized && !isOverlayMessageEmpty(normalized)) {
        quillInstance.clipboard.dangerouslyPasteHTML(0, normalized);
    }
}

export function getScheduleOverlayMessageEditorHtml() {
    if (!quillInstance) return null;
    const text = quillInstance.getText().trim();
    if (!text) return null;
    return normalizeEditorHtml(quillInstance.root.innerHTML);
}

export function setScheduleOverlayMessageEditorPlaceholder(placeholder) {
    if (!quillInstance?.root) return;
    quillInstance.root.dataset.placeholder = placeholder || '';
}

export function setScheduleOverlayMessageEditorEnabled(enabled) {
    if (!quillInstance) return;
    quillInstance.enable(enabled);
}

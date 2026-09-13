// Shared time-input helpers: hour/minute popover scrolling and the popover
// close-all used by the schedule segment editor and the pause/override dialogs.
// The timer (fixed-duration) controls that used to live here are gone: a
// Manual focus space runs until it is stopped.

export function pad(num) {
    return num.toString().padStart(2, '0');
}

export function parseEndTimeBoundedInt(raw, min, max) {
    const digits = String(raw ?? '').replace(/\D/g, '');
    if (digits === '') return null;
    const n = parseInt(digits, 10);
    if (Number.isNaN(n)) return null;
    return Math.min(max, Math.max(min, n));
}

export function scrollPopoverOptionIntoView(scrollContainer, option) {
    if (!scrollContainer || !option) return;
    const optionTop = option.offsetTop;
    const optionHeight = option.offsetHeight;
    const containerHeight = scrollContainer.clientHeight;
    scrollContainer.scrollTop = Math.max(0, optionTop - (containerHeight - optionHeight) / 2);
}

/** Scroll an element into view inside a scroll container only — avoids panning the page. */
export function scrollElementWithinContainer(scrollContainer, element, padding = 12) {
    if (!scrollContainer || !element) return;
    const containerRect = scrollContainer.getBoundingClientRect();
    const elementRect = element.getBoundingClientRect();
    if (elementRect.bottom > containerRect.bottom - padding) {
        scrollContainer.scrollTop += elementRect.bottom - containerRect.bottom + padding;
    } else if (elementRect.top < containerRect.top + padding) {
        scrollContainer.scrollTop -= containerRect.top + padding - elementRect.top;
    }
}

export function readRootCssPx(varName) {
    const raw = getComputedStyle(document.documentElement).getPropertyValue(varName).trim();
    if (!raw) return 0;
    const probe = document.createElement('div');
    probe.style.cssText = 'position:absolute;visibility:hidden;pointer-events:none;height:' + raw;
    document.body.appendChild(probe);
    const px = parseFloat(getComputedStyle(probe).height) || 0;
    probe.remove();
    return px;
}

// Close all popovers
export function closeAllPopovers() {
    document.querySelectorAll('.time-popover:not(.schedule-time-popover)').forEach(p => p.classList.add('hidden'));
    document.querySelectorAll('.schedule-time-popover').forEach(p => p.remove());
    document.querySelectorAll('.time-part.active, .time-popover-anchor.active').forEach(el =>
        el.classList.remove('active'));
}

// Handle clicks outside popovers
export function handlePopoverOutsideClick(e) {
    if (
        e.target.closest('.time-popover') ||
        e.target.closest('.time-popover-anchor') ||
        e.target.closest('.schedule-start-display input.time-part') ||
        e.target.closest('.schedule-end-display input.time-part') ||
        e.target.closest('input.time-part.time-popover-anchor') ||
        e.target.closest('button.time-part')
    ) {
        return;
    }
    closeAllPopovers();
}

// Handle click on a time-part anchor (pause dialog restart time): open its list.
export function handleTimePartClick(e) {
    e.stopPropagation();
    const btn = e.currentTarget;
    const type = btn.dataset.type;
    const target = btn.dataset.target;

    // Close all popovers first (keep row scroll position when switching fields)
    closeAllPopovers();

    // Open the relevant popover
    const popover = document.getElementById(`${target}-${type}-popover`);
    if (!popover) return;
    popover.classList.remove('hidden');
    btn.classList.add('active');

    // Scroll to selected option inside the popover only
    const scroll = popover.querySelector('.popover-scroll');
    const selectedOption = popover.querySelector('.popover-option.selected');
    scrollPopoverOptionIntoView(scroll, selectedOption);
}

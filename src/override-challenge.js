// Override challenge generation: word list, word-count difficulty math.
// Extracted verbatim from app.js.
import { state } from './state.js';
import { tSettings, tSettingsFmt, getSettingsLanguage } from './i18n.js';
import { escapeHtml } from './utils.js';

/**
 * Scroll `container` so a vertical position in its content sits ~35% from
 * the top. Uses scrollTop directly: scrollIntoView is unreliable for nested
 * overflow boxes inside the Tauri/WKWebView modal.
 *
 * Snaps to whole line-heights / integer pixels — fractional scrollTop plus
 * rewriting text during scroll was producing a smeared/half-height line in
 * WKWebView until the next keystroke forced a repaint.
 */
function scrollChallengeContentToY(container, contentY) {
    if (!container) return;
    const viewH = container.clientHeight;
    if (viewH <= 0) return;

    const lineHeight = (() => {
        const raw = getComputedStyle(container).lineHeight;
        const parsed = parseFloat(raw);
        if (Number.isFinite(parsed) && parsed > 0) return parsed;
        const fontSize = parseFloat(getComputedStyle(container).fontSize) || 15;
        return fontSize * 1.6;
    })();

    const desired = contentY - viewH * 0.35;
    const snapped = Math.round(desired / lineHeight) * lineHeight;
    const maxScroll = Math.max(0, container.scrollHeight - viewH);
    const next = Math.max(0, Math.min(maxScroll, snapped));
    if (Math.abs(container.scrollTop - next) < 0.5) return;
    container.scrollTop = next;
}

/** Scroll so character `index` in a plain-text challenge box stays in view. */
function scrollChallengeToCharIndex(container, index) {
    if (!container) return;
    const textNode = container.firstChild;
    if (!textNode || textNode.nodeType !== Node.TEXT_NODE || textNode.length === 0) return;

    const safeIndex = Math.min(Math.max(0, index), textNode.length);
    const range = document.createRange();
    if (safeIndex >= textNode.length) {
        range.setStart(textNode, textNode.length);
        range.collapse(true);
    } else {
        range.setStart(textNode, safeIndex);
        range.setEnd(textNode, safeIndex + 1);
    }

    const cRect = container.getBoundingClientRect();
    const mRect = range.getBoundingClientRect();
    // Collapsed end-of-text ranges can report an empty rect — fall back.
    if (!mRect || (mRect.height === 0 && mRect.width === 0 && safeIndex >= textNode.length)) {
        scrollChallengeContentToY(container, container.scrollHeight);
        return;
    }
    scrollChallengeContentToY(container, container.scrollTop + (mRect.top - cRect.top));
}

function scrollChallengeToElement(container, marker) {
    if (!container || !marker) return;
    const cRect = container.getBoundingClientRect();
    const mRect = marker.getBoundingClientRect();
    scrollChallengeContentToY(container, container.scrollTop + (mRect.top - cRect.top));
}

function scheduleChallengeScroll(scrollFn) {
    requestAnimationFrame(scrollFn);
}

/**
 * Render challenge reference text and auto-scroll so the current typing
 * position (or first error) stays in view with upcoming words visible.
 * While typing correctly we keep plain text (no span) so kerning/spacing
 * isn't disturbed; errors still use .error-char.
 * @param {HTMLElement|null} el
 * @param {string} text
 * @param {{ cursorIndex?: number, errorIndex?: number }} [opts]
 */
export function renderChallengeReferenceText(el, text, { cursorIndex = 0, errorIndex = -1 } = {}) {
    if (!el) return;
    const target = typeof text === 'string' ? text : '';
    const hasError = errorIndex >= 0 && errorIndex < target.length;
    const markIndex = hasError
        ? errorIndex
        : Math.min(Math.max(0, Number(cursorIndex) || 0), target.length);

    if (target.length === 0) {
        el.textContent = '';
        el.removeAttribute('data-challenge-render');
        return;
    }

    if (hasError) {
        const before = escapeHtml(target.slice(0, markIndex));
        const rawMark = target[markIndex];
        const isSpace = /\s/.test(rawMark);
        const markChar = isSpace ? ' ' : escapeHtml(rawMark);
        const after = escapeHtml(target.slice(markIndex + 1));
        const markClass = isSpace ? 'error-char error-char-space' : 'error-char';
        el.innerHTML = `${before}<span class="${markClass}">${markChar}</span>${after}`;
        el.setAttribute('data-challenge-render', 'error');
        const marker = el.querySelector('.error-char');
        scheduleChallengeScroll(() => scrollChallengeToElement(el, marker));
        return;
    }

    // Avoid rewriting the text node on every keystroke — that + scroll was
    // painting a smeared line in WKWebView until the next input forced a repaint.
    if (el.getAttribute('data-challenge-render') !== 'plain' || el.textContent !== target) {
        el.textContent = target;
        el.setAttribute('data-challenge-render', 'plain');
    }

    if (markIndex >= target.length) {
        el.scrollTop = el.scrollHeight;
        return;
    }
    scheduleChallengeScroll(() => scrollChallengeToCharIndex(el, markIndex));
}

/**
 * Fold typographic lookalikes (smart quotes, dashes, etc.) to keyboard-ASCII
 * equivalents and strip invisible format characters so custom override text
 * matches what users type. Idempotent; safe on both saved target text and
 * live typed input.
 */
export function normalizeChallengeComparableText(value) {
    return String(value ?? '')
        .normalize('NFC')
        // ZWSP / ZWNJ / ZWJ, BOM/ZWNBSP, word joiner, soft hyphen (strip — not a real hyphen)
        .replace(/[\u200B-\u200D\uFEFF\u2060\u00AD]/g, '')
        .replace(/[\u00A0\u202F\u2007]/g, ' ') // nbsp / narrow nbsp / figure space
        .replace(/[\u2018\u2019\u201A\u201B\u2032\u2035\u02BC\u02B9]/g, "'") // curly/modifier apostrophes & primes
        .replace(/[\u201C\u201D\u201E\u201F\u00AB\u00BB]/g, '"') // curly / guillemet quotes
        .replace(/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g, '-') // hyphen / en / em / minus
        .replace(/\u2026/g, '...'); // ellipsis
}

/** Challenge text is single-spaced — collapse runs of whitespace to one space. */
export function sanitizeChallengeTypedInput(value) {
    return normalizeChallengeComparableText(
        String(value ?? '').replace(/^\s+/, '').replace(/\s{2,}/g, ' ')
    );
}

/** Sanitize challenge target: newlines → space, collapse spaces, fold lookalikes. */
export function sanitizeChallengeTargetText(value) {
    return normalizeChallengeComparableText(
        String(value ?? '').replace(/[\r\n]+/g, ' ').replace(/\s{2,}/g, ' ').trim()
    );
}

/**
 * Apply single-space sanitization to a challenge textarea, preserving the
 * caret as much as possible. Returns the sanitized value.
 * @param {HTMLInputElement|HTMLTextAreaElement|null} inputEl
 */
export function applyChallengeTypedInputSanitization(inputEl) {
    if (!inputEl) return '';
    const raw = inputEl.value;
    const sanitized = sanitizeChallengeTypedInput(raw);
    if (raw === sanitized) return sanitized;
    const sel = inputEl.selectionStart ?? sanitized.length;
    const newSel = sanitizeChallengeTypedInput(raw.slice(0, sel)).length;
    inputEl.value = sanitized;
    try {
        inputEl.setSelectionRange(newSel, newSel);
    } catch {
        // Some platforms reject setSelectionRange on briefly-detached nodes.
    }
    return sanitized;
}

/** Block Space when it would create a leading or doubled space. */
export function shouldBlockChallengeSpaceKey(inputEl, event) {
    if (!inputEl || (event.key !== ' ' && event.code !== 'Space')) return false;
    if (event.metaKey || event.ctrlKey || event.altKey) return false;
    const start = inputEl.selectionStart ?? 0;
    if (start === 0) return true;
    return /\s/.test(inputEl.value[start - 1] || '');
}

// ── Override difficulty ───────────────────────────────────────────────────
// `overrideDifficulty.count` is a number of WORDS on every platform (five-letter
// words from the list below). Custom text is typed verbatim and has no count.
export const OVERRIDE_TYPES = Object.freeze(['random-words', 'custom']);
export const MIN_OVERRIDE_WORDS = 1;
export const DEFAULT_OVERRIDE_WORDS = 15;
/** Kept for older callers; same value as DEFAULT_OVERRIDE_WORDS. */
export const DEFAULT_OVERRIDE_COUNT = DEFAULT_OVERRIDE_WORDS;
export const MAX_OVERRIDE_WORDS_DESKTOP = 300;
/** Phones: Android's native gate clamps at its 111-word list anyway. */
export const MAX_OVERRIDE_WORDS_MOBILE = 100;
export const MAX_CUSTOM_OVERRIDE_CHARS = 7500;
/** Letters per generated word (the pool is five-letter words). */
export const LETTERS_PER_WORD = 5;
/** Average characters (letters + space) one desktop word used to cost — for migrating old counts. */
export const LEGACY_CHARS_PER_WORD = 6;
/** When the preview reaches this many characters it is frozen (no more regeneration). */
export const OVERRIDE_PREVIEW_TRUNCATE_AT = 50;

/**
 * Word-by-word challenge primitives. Moved here from app.js: they are pure
 * challenge logic with no DOM or app-state dependency, and living in a leaf
 * module lets the test harness import them without an app.js import cycle.
 */
export function buildWordChallengeState(text) {
    const words = String(text || '').split(/\s+/).filter(Boolean);
    return {
        words,
        currentIndex: 0,
        typedText: ''
    };
}

export function isMobileOverrideChallengePlatform() {
    return state.isIOS || state.isAndroid;
}

/** Phones type the challenge one word at a time; desktop types the whole text. */
export function isMobileWordByWordChallenge(difficulty) {
    return !!(isMobileOverrideChallengePlatform() && normalizeOverrideType(difficulty?.type) === 'random-words');
}

export function getCurrentChallengeWord(challengeState) {
    if (!challengeState || challengeState.currentIndex >= challengeState.words.length) return '';
    return challengeState.words[challengeState.currentIndex];
}

export function getCompletedChallengeText(challengeState) {
    if (!challengeState || challengeState.currentIndex <= 0) return '';
    return challengeState.words.slice(0, challengeState.currentIndex).join(' ');
}

export function normalizeOverrideType(type) {
    return type === 'custom' ? 'custom' : 'random-words';
}

/** Random words are counted in words on every platform; custom text has no count. */
export function usesWordCountForOverrideType(type) {
    return normalizeOverrideType(type) === 'random-words';
}

export function getMaxOverrideWords(mobile = isMobileOverrideChallengePlatform()) {
    return mobile ? MAX_OVERRIDE_WORDS_MOBILE : MAX_OVERRIDE_WORDS_DESKTOP;
}

/** Five-letter words only — used for iOS word-count random-words (predictable length per word). */
let wordList5Cache = null;

export const wordList = [
    // 1-2 chars
    'a', 'ad', 'am', 'an', 'as', 'at', 'be', 'by', 'do', 'go', 'he', 'hi', 'if', 'in', 'is', 'it', 'me', 'my', 'no', 'of', 'on', 'or', 'so', 'to', 'up', 'us', 'we',
    // 3 chars
    'act', 'add', 'age', 'aim', 'air', 'all', 'and', 'any', 'art', 'ask', 'bad', 'bag', 'bar', 'bat', 'bed', 'bee', 'big', 'bit', 'box', 'boy', 'bus', 'but', 'buy', 'can', 'car', 'cat', 'day', 'die', 'dog', 'dry', 'due', 'eat', 'egg', 'end', 'eye', 'far', 'few', 'fit', 'fly', 'for', 'fun', 'get', 'god', 'got', 'guy', 'hot', 'how', 'ice', 'ill', 'ink', 'job', 'joy', 'key', 'kid', 'law', 'lay', 'leg', 'let', 'lie', 'log', 'lot', 'low', 'man', 'map', 'may', 'men', 'mix', 'net', 'new', 'nod', 'nor', 'not', 'now', 'num', 'off', 'oil', 'old', 'one', 'out', 'own', 'pay', 'pen', 'per', 'pet', 'pie', 'pig', 'pin', 'pot', 'put', 'ran', 'raw', 'red', 'row', 'run', 'sad', 'say', 'sea', 'see', 'set', 'she', 'sin', 'sit', 'six', 'sky', 'son', 'sun', 'tap', 'tax', 'tea', 'ten', 'the', 'tie', 'tip', 'toe', 'too', 'top', 'toy', 'try', 'two', 'use', 'van', 'war', 'way', 'who', 'why', 'win', 'yes', 'yet', 'you',
    // 4 chars
    'also', 'able', 'acid', 'aged', 'away', 'baby', 'back', 'ball', 'bank', 'base', 'bath', 'bear', 'beat', 'beer', 'bell', 'belt', 'best', 'bill', 'bird', 'blow', 'blue', 'boat', 'body', 'bomb', 'bond', 'bone', 'book', 'boom', 'born', 'boss', 'both', 'bowl', 'burn', 'busy', 'call', 'calm', 'came', 'camp', 'card', 'care', 'case', 'cash', 'cast', 'cell', 'chat', 'chip', 'city', 'club', 'coal', 'coat', 'code', 'cold', 'come', 'cook', 'cool', 'cope', 'core', 'cost', 'crew', 'crop', 'dark', 'date', 'dead', 'deal', 'dean', 'dear', 'debt', 'deep', 'deny', 'desk', 'dial', 'diet', 'disc', 'disk', 'does', 'done', 'door', 'dose', 'down', 'draw', 'drew', 'drop', 'drug', 'dual', 'duke', 'dust', 'duty', 'each', 'earn', 'ease', 'east', 'easy', 'edge', 'edit', 'else', 'even', 'ever', 'evil', 'exit', 'face', 'fact', 'fail', 'fair', 'fall', 'farm', 'fast', 'fate', 'fear', 'feed', 'feel', 'feet', 'fell', 'felt', 'file', 'fill', 'film', 'find', 'fine', 'fire', 'firm', 'fish', 'five', 'flat', 'fled', 'flew', 'flow', 'food', 'foot', 'ford', 'form', 'fort', 'four', 'free', 'from', 'fuel', 'full', 'fund', 'gain', 'game', 'gate', 'gave', 'gear', 'gene', 'gift', 'girl', 'give', 'glad', 'goal', 'goes', 'gold', 'golf', 'gone', 'good', 'gray', 'grew', 'grey', 'grow', 'hair', 'half', 'hall', 'hand', 'hang', 'hard', 'harm', 'hate', 'have', 'head', 'hear', 'heat', 'held', 'hell', 'help', 'here', 'hero', 'high', 'hill', 'hire', 'hold', 'hole', 'holy', 'home', 'hope', 'host', 'hour', 'huge', 'hung', 'hunt', 'hurt', 'idea', 'inch', 'into', 'iron', 'item', 'join', 'joke', 'jump', 'jury', 'just', 'keep', 'kept', 'kick', 'kill', 'kind', 'king', 'knee', 'knew', 'know', 'lack', 'lady', 'laid', 'lake', 'land', 'lane', 'last', 'late', 'lead', 'left', 'less', 'life', 'lift', 'like', 'line', 'link', 'list', 'live', 'load', 'loan', 'lock', 'logo', 'long', 'look', 'lord', 'lose', 'loss', 'lost', 'love', 'luck', 'made', 'mail', 'main', 'make', 'male', 'many', 'mark', 'mass', 'mate', 'math', 'meal', 'mean', 'meat', 'meet', 'menu', 'mere', 'mile', 'milk', 'mill', 'mind', 'mine', 'miss', 'mode', 'mood', 'moon', 'more', 'most', 'move', 'much', 'must', 'name', 'navy', 'near', 'neck', 'need', 'news', 'next', 'nice', 'nick', 'nine', 'none', 'nose', 'note', 'okay', 'once', 'only', 'onto', 'open', 'oral', 'over', 'pace', 'pack', 'page', 'paid', 'pain', 'pair', 'palm', 'park', 'part', 'pass', 'past', 'path', 'peak', 'pick', 'pile', 'pink', 'pipe', 'plan', 'play', 'plot', 'plug', 'plus', 'poll', 'pool', 'poor', 'port', 'post', 'pull', 'pure', 'push', 'race', 'rail', 'rain', 'rank', 'rare', 'rate', 'read', 'real', 'rear', 'rely', 'rent', 'rest', 'rice', 'rich', 'ride', 'ring', 'rise', 'risk', 'road', 'rock', 'role', 'roll', 'roof', 'room', 'root', 'rose', 'rule', 'rush', 'safe', 'said', 'sake', 'sale', 'salt', 'same', 'sand', 'save', 'seat', 'seed', 'seek', 'seem', 'seen', 'self', 'sell', 'send', 'sent', 'ship', 'shop', 'shot', 'show', 'shut', 'sick', 'side', 'sign', 'silk', 'site', 'size', 'skin', 'slip', 'slow', 'snow', 'soft', 'soil', 'sold', 'sole', 'some', 'song', 'soon', 'sort', 'soul', 'spot', 'star', 'stay', 'step', 'stop', 'such', 'suit', 'sure', 'take', 'tale', 'talk', 'tall', 'tank', 'tape', 'task', 'team', 'tech', 'tell', 'tend', 'term', 'test', 'text', 'than', 'that', 'them', 'then', 'they', 'thin', 'this', 'thus', 'till', 'time', 'tiny', 'told', 'toll', 'tone', 'took', 'tool', 'tour', 'town', 'tree', 'trip', 'true', 'tune', 'turn', 'twin', 'type', 'unit', 'upon', 'used', 'user', 'vary', 'vast', 'very', 'vice', 'view', 'vote', 'wage', 'wait', 'wake', 'walk', 'wall', 'want', 'ward', 'warm', 'wash', 'wave', 'ways', 'weak', 'wear', 'week', 'well', 'went', 'were', 'west', 'what', 'when', 'whom', 'wide', 'wife', 'wild', 'will', 'wind', 'wine', 'wing', 'wire', 'wise', 'wish', 'with', 'wood', 'word', 'work', 'yard', 'yeah', 'year', 'your', 'zero', 'zone',
    // 5+ chars (selection)
    'about', 'above', 'abuse', 'actor', 'acute', 'admit', 'adopt', 'adult', 'after', 'again', 'agent', 'agree', 'ahead', 'alarm', 'album', 'alert', 'alike', 'alive', 'allow', 'alone', 'along', 'alter', 'among', 'anger', 'angle', 'angry', 'apart', 'apple', 'apply', 'arena', 'argue', 'arise', 'array', 'aside', 'asset', 'audio', 'audit', 'avoid', 'award', 'aware', 'badly', 'baker', 'bases', 'basic', 'basis', 'beach', 'began', 'begin', 'begun', 'being', 'below', 'bench', 'birth', 'black', 'blame', 'blind', 'block', 'blood', 'board', 'boost', 'booth', 'bound', 'brain', 'brand', 'bread', 'break', 'breed', 'brief', 'bring', 'broad', 'brown', 'brush', 'build', 'built', 'buyer', 'cable', 'carry', 'catch', 'cause', 'chain', 'chair', 'chart', 'chase', 'cheap', 'check', 'chest', 'chief', 'child', 'china', 'chose', 'civil', 'claim', 'class', 'clean', 'clear', 'click', 'clock', 'close', 'coach', 'coast', 'could', 'count', 'court', 'cover', 'craft', 'crash', 'cream', 'crime', 'cross', 'crowd', 'crown', 'curve', 'cycle', 'daily', 'dance', 'dated', 'dealt', 'death', 'debut', 'delay', 'depth', 'doing', 'doubt', 'dozen', 'draft', 'drama', 'drawn', 'dream', 'dress', 'drill', 'drink', 'drive', 'drove', 'dying', 'eager', 'early', 'earth', 'eight', 'elite', 'empty', 'enemy', 'enjoy', 'enter', 'entry', 'equal', 'error', 'event', 'every', 'exact', 'exist', 'extra', 'faith', 'false', 'fault', 'fiber', 'field', 'fifth', 'fifty', 'fight', 'final', 'first', 'fixed', 'flash', 'fleet', 'floor', 'fluid', 'focus', 'force', 'forth', 'forty', 'forum', 'found', 'frame', 'frank', 'fraud', 'fresh', 'front', 'fruit', 'fully', 'funny', 'giant', 'given', 'glass', 'globe', 'going', 'grace', 'grade', 'grand', 'grant', 'grass', 'great', 'green', 'gross', 'group', 'grown', 'guard', 'guess', 'guest', 'guide', 'happy', 'heart', 'heavy', 'hence', 'horse', 'hotel', 'house', 'human', 'ideal', 'image', 'index', 'inner', 'input', 'issue', 'japan', 'joint', 'judge', 'known', 'label', 'large', 'laser', 'later', 'laugh', 'layer', 'learn', 'lease', 'least', 'leave', 'legal', 'level', 'light', 'limit', 'links', 'lives', 'local', 'logic', 'loose', 'lower', 'lucky', 'lunch', 'lying', 'magic', 'major', 'maker', 'march', 'match', 'maybe', 'mayor', 'limit', 'admit', 'adult', 'advice', 'affect', 'afford', 'afraid', 'agency', 'agenda', 'almost', 'always', 'amount', 'animal', 'annual', 'answer', 'anyway', 'appeal', 'appear', 'aspect', 'assist', 'assume', 'attack', 'attend', 'august', 'author', 'avenue', 'backed', 'barely', 'battle', 'beauty', 'became', 'become', 'before', 'behalf', 'behind', 'belief', 'belong', 'berlin', 'better', 'beyond', 'bishop', 'border', 'bottle', 'bottom', 'bought', 'branch', 'breath', 'bridge', 'bright', 'broken', 'budget', 'burden', 'bureau', 'button', 'camera', 'cancer', 'cannot', 'carbon', 'career', 'castle', 'casual', 'caught', 'center', 'centre', 'chance', 'change', 'charge', 'choice', 'choose', 'chosen', 'church', 'circle', 'client', 'closed', 'closer', 'coffee', 'column', 'combat', 'coming', 'common', 'comply', 'copper', 'corner', 'costly', 'county', 'couple', 'course', 'covers', 'create', 'credit'
];

export function getWordList5() {
    if (!wordList5Cache) {
        wordList5Cache = wordList.filter(w => w.length === 5);
    }
    return wordList5Cache;
}

/** Typed letters only for N five-letter words (spaces in display are not counted). */
export function getIOSRandomWordsCharCount(wordCount) {
    const n = Math.max(0, Math.floor(wordCount));
    return n * 5;
}

/** iOS: generate exactly `wordCount` random five-letter words. */
export function generateRandomWordsByCount(wordCount) {
    const n = Math.max(0, Math.floor(wordCount));
    if (n === 0) return '';
    const pool = getWordList5();
    if (pool.length === 0) return '';
    const words = [];
    for (let i = 0; i < n; i++) {
        words.push(pool[Math.floor(Math.random() * pool.length)]);
    }
    return words.join(' ');
}

export function generateOverrideChallengeText(type, count, customText = '') {
    if (normalizeOverrideType(type) === 'custom' && customText) return customText;
    return generateRandomWordsByCount(normalizeOverrideCount(count, 'random-words'));
}

/** Clamp a word count to [1, max words]; anything unparseable is the default. */
export function normalizeOverrideCount(value, type = 'random-words', maxWords = getMaxOverrideWords()) {
    const parsed = parseInt(value, 10);
    if (!Number.isFinite(parsed)) return DEFAULT_OVERRIDE_WORDS;
    const max = Math.max(MIN_OVERRIDE_WORDS, Number(maxWords) || getMaxOverrideWords());
    return Math.min(max, Math.max(MIN_OVERRIDE_WORDS, parsed));
}

export function normalizeCustomOverrideText(value) {
    const text = sanitizeChallengeTargetText(typeof value === 'string' ? value : '');
    return text.slice(0, MAX_CUSTOM_OVERRIDE_CHARS);
}

export function getTypingCharsPerMinuteForType() {
    return 200; // estimate only
}

export function getMinOverrideCountForType(type) {
    return normalizeOverrideType(type) === 'custom' ? 1 : MIN_OVERRIDE_WORDS;
}

/** Upper bound of the count field: words for random words, characters for custom text. */
export function getMaxOverrideCountForType(type) {
    return normalizeOverrideType(type) === 'custom' ? MAX_CUSTOM_OVERRIDE_CHARS : getMaxOverrideWords();
}

/** Typed letters for N words (spaces are not typed on the word-by-word phone gate). */
export function getOverrideGeneratedCharCount(type, count) {
    if (normalizeOverrideType(type) === 'custom') return 0;
    const parsed = Number.parseInt(count, 10);
    const words = Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
    return words * LETTERS_PER_WORD;
}

/** Letters-only workload for comparing override difficulties (e.g. override-all hardest). */
export function getDifficultyTypingCharCount(difficulty) {
    if (!difficulty) return 0;
    if (normalizeOverrideType(difficulty.type) === 'custom') {
        return typeof difficulty.customText === 'string' ? difficulty.customText.length : 0;
    }
    return getOverrideGeneratedCharCount('random-words', normalizeOverrideCount(difficulty.count, 'random-words'));
}

/** Preview text for the editor's "Looks like" box. */
export function getOverridePreviewText(type, count, customText) {
    if (normalizeOverrideType(type) === 'custom') {
        const normalized = sanitizeChallengeTargetText(typeof customText === 'string' ? customText : '');
        return normalized || 'Your custom text will appear here';
    }
    const words = normalizeOverrideCount(count, 'random-words');
    if (type !== state.lastOverridePreviewType) {
        state.lastOverridePreviewType = type;
        state.overridePreviewFrozenByType['random-words'] = null;
    }
    if (getOverrideGeneratedCharCount('random-words', words) >= OVERRIDE_PREVIEW_TRUNCATE_AT) {
        let frozen = state.overridePreviewFrozenByType['random-words'];
        if (frozen != null) return frozen;
        frozen = generateRandomWordsByCount(words).slice(0, OVERRIDE_PREVIEW_TRUNCATE_AT);
        state.overridePreviewFrozenByType['random-words'] = frozen;
        return frozen;
    }
    return generateRandomWordsByCount(words);
}

/** Estimated minutes to type the challenge (letters at ~200 per minute). */
export function getOverrideEstimatedMinutes(type, count, customText) {
    if (normalizeOverrideType(type) === 'custom') {
        const charCount = typeof customText === 'string' ? customText.length : 0;
        if (charCount <= 0) return 0;
        return Math.ceil(charCount / getTypingCharsPerMinuteForType());
    }
    const parsed = Number.parseInt(count, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) return 0;
    return Math.ceil(getOverrideGeneratedCharCount('random-words', parsed) / getTypingCharsPerMinuteForType());
}

/**
 * Normalize a stored difficulty to the current shape `{ type, count, customText }`.
 *
 * Older data can carry `gibberish` (dropped: becomes random words),
 * `maxDifficulty` with `countBeforeMax` / `typeBeforeMax` (dropped: becomes the
 * platform maximum — the failure falls toward blocking), and, on desktop, a
 * `count` that was a CHARACTER target (`countsAreChars`: divide by the average
 * six characters a word used to cost, never below one word). Phone stores
 * already counted words and are only clamped.
 */
export function migrateOverrideDifficultyToWords(raw, { maxWords, countsAreChars }) {
    const max = Math.max(MIN_OVERRIDE_WORDS, Number(maxWords) || MAX_OVERRIDE_WORDS_DESKTOP);
    const type = normalizeOverrideType(raw?.type);
    const customText = type === 'custom' ? normalizeCustomOverrideText(raw?.customText) : '';
    if (type === 'custom') {
        return { type, count: DEFAULT_OVERRIDE_WORDS, customText };
    }
    if (raw?.maxDifficulty === true) {
        return { type, count: max, customText: '' };
    }
    const parsed = Number.parseInt(raw?.count, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) {
        return { type, count: Math.min(max, DEFAULT_OVERRIDE_WORDS), customText: '' };
    }
    const words = countsAreChars ? Math.round(parsed / LEGACY_CHARS_PER_WORD) : parsed;
    return { type, count: Math.min(max, Math.max(MIN_OVERRIDE_WORDS, words)), customText: '' };
}

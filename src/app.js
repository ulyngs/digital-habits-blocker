// Tauri API imports - proper ES modules from @tauri-apps/api
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { ask, message } from '@tauri-apps/plugin-dialog';

// Compatibility layer wrapping Tauri APIs
const tauriAPI = {
    // Core data operations
    loadData: () => invoke('load_data'),
    saveData: (data) => invoke('save_data', { data }),
    getAppVersion: () => invoke('get_app_version'),

    // Window operations
    setWindowSize: (width, height) => invoke('set_window_size', { width, height }),
    minimizeWindow: () => getCurrentWindow().minimize(),
    maximizeWindow: async () => {
        const win = getCurrentWindow();
        if (await win.isMaximized()) {
            return win.unmaximize();
        }
        return win.maximize();
    },
    closeWindow: () => getCurrentWindow().hide(),

    // Helper daemon operations
    checkHelperStatus: () => invoke('check_helper_status').catch(() => ({ installed: false, running: false })),
    checkHelper: async () => {
        const status = await invoke('check_helper_status').catch(() => ({ installed: false, running: false }));
        return status.running === true;
    },
    installHelper: () => invoke('install_helper'),
    uninstallHelper: () => invoke('uninstall_helper'),
    startBlockViaHelper: (data) => invoke('start_block_via_helper', { ...data }),
    clearBlockViaHelper: () => invoke('clear_block_via_helper'),

    // App operations
    openAppPicker: () => invoke('open_app_picker'),
    blockWebsites: (domains) => invoke('block_websites', { domains }),
    refreshBlockedApps: () => invoke('refresh_blocked_apps').catch(() => { }),

    // Process watcher for app blocking
    setBlockedApps: (apps) => invoke('set_blocked_apps', { apps }),
    startProcessWatcher: () => invoke('start_process_watcher'),
    stopProcessWatcher: () => invoke('stop_process_watcher'),
    hideAllBlockedApps: () => invoke('hide_all_blocked_apps'),

    // Event listening
    onBlocksUpdated: (callback) => listen('blocks-updated', callback),
};

// State
let appData = {
    blocklists: [],
    activeBlocks: [],
    schedules: [],
    settings: {
        onboardingComplete: false
    }
};

// Expose for integration tests (dev mode only)
window.__REDDBLOCK_INTERNALS__ = {
    get appData() { return appData; },
    set appData(val) { appData = val; }
};

let selectedBlocklistId = null;
let editingBlocklistId = null;
let overrideBlockId = null;
let challengeText = '';
let lastBlockedDomains = new Set(); // Track what's currently blocked to avoid re-prompting
let lastBlockedApps = new Set(); // Track blocked apps to avoid redundant updates
let activatedBlockIds = new Set(); // Track blocks that have already triggered host updates
let helperAvailable = false; // Track if the privileged helper daemon is running
let pendingBlockData = null; // Store block data when waiting for helper installation
let draggedBlocklistId = null; // Track which blocklist is being dragged

// Week calendar state
let currentWeekStart = null; // Date object for Monday of the displayed week

// Schedule mode state
let isScheduleMode = false; // false = instant mode, true = schedule mode
let scheduleSegments = getDefaultScheduleSegments(); // Array of time segments with per-segment days
let scheduleRepeatType = 'no'; // 'no', 'forever', or 'date'
let scheduleRepeatDate = null; // Date object when repeatType is 'date'
let activeScheduleSegmentCount = 0; // Number of segments locked in the active schedule (new segments can be added)

// Word list for random word challenges
const wordList = [
    // 1-2 chars
    'a', 'ad', 'am', 'an', 'as', 'at', 'be', 'by', 'do', 'go', 'he', 'hi', 'if', 'in', 'is', 'it', 'me', 'my', 'no', 'of', 'on', 'or', 'so', 'to', 'up', 'us', 'we',
    // 3 chars
    'act', 'add', 'age', 'aim', 'air', 'all', 'and', 'any', 'art', 'ask', 'bad', 'bag', 'bar', 'bat', 'bed', 'bee', 'big', 'bit', 'box', 'boy', 'bus', 'but', 'buy', 'can', 'car', 'cat', 'day', 'die', 'dog', 'dry', 'due', 'eat', 'egg', 'end', 'eye', 'far', 'few', 'fit', 'fly', 'for', 'fun', 'get', 'god', 'got', 'guy', 'hot', 'how', 'ice', 'ill', 'ink', 'job', 'joy', 'key', 'kid', 'law', 'lay', 'leg', 'let', 'lie', 'log', 'lot', 'low', 'man', 'map', 'may', 'men', 'mix', 'net', 'new', 'nod', 'nor', 'not', 'now', 'num', 'off', 'oil', 'old', 'one', 'out', 'own', 'pay', 'pen', 'per', 'pet', 'pie', 'pig', 'pin', 'pot', 'put', 'ran', 'raw', 'red', 'row', 'run', 'sad', 'say', 'sea', 'see', 'set', 'she', 'sin', 'sit', 'six', 'sky', 'son', 'sun', 'tap', 'tax', 'tea', 'ten', 'the', 'tie', 'tip', 'toe', 'too', 'top', 'toy', 'try', 'two', 'use', 'van', 'war', 'way', 'who', 'why', 'win', 'yes', 'yet', 'you',
    // 4 chars
    'also', 'able', 'acid', 'aged', 'away', 'baby', 'back', 'ball', 'bank', 'base', 'bath', 'bear', 'beat', 'beer', 'bell', 'belt', 'best', 'bill', 'bird', 'blow', 'blue', 'boat', 'body', 'bomb', 'bond', 'bone', 'book', 'boom', 'born', 'boss', 'both', 'bowl', 'burn', 'busy', 'call', 'calm', 'came', 'camp', 'card', 'care', 'case', 'cash', 'cast', 'cell', 'chat', 'chip', 'city', 'club', 'coal', 'coat', 'code', 'cold', 'come', 'cook', 'cool', 'cope', 'core', 'cost', 'crew', 'crop', 'dark', 'date', 'dead', 'deal', 'dean', 'dear', 'debt', 'deep', 'deny', 'desk', 'dial', 'diet', 'disc', 'disk', 'does', 'done', 'door', 'dose', 'down', 'draw', 'drew', 'drop', 'drug', 'dual', 'duke', 'dust', 'duty', 'each', 'earn', 'ease', 'east', 'easy', 'edge', 'edit', 'else', 'even', 'ever', 'evil', 'exit', 'face', 'fact', 'fail', 'fair', 'fall', 'farm', 'fast', 'fate', 'fear', 'feed', 'feel', 'feet', 'fell', 'felt', 'file', 'fill', 'film', 'find', 'fine', 'fire', 'firm', 'fish', 'five', 'flat', 'fled', 'flew', 'flow', 'food', 'foot', 'ford', 'form', 'fort', 'four', 'free', 'from', 'fuel', 'full', 'fund', 'gain', 'game', 'gate', 'gave', 'gear', 'gene', 'gift', 'girl', 'give', 'glad', 'goal', 'goes', 'gold', 'golf', 'gone', 'good', 'gray', 'grew', 'grey', 'grow', 'hair', 'half', 'hall', 'hand', 'hang', 'hard', 'harm', 'hate', 'have', 'head', 'hear', 'heat', 'held', 'hell', 'help', 'here', 'hero', 'high', 'hill', 'hire', 'hold', 'hole', 'holy', 'home', 'hope', 'host', 'hour', 'huge', 'hung', 'hunt', 'hurt', 'idea', 'inch', 'into', 'iron', 'item', 'join', 'joke', 'jump', 'jury', 'just', 'keep', 'kept', 'kick', 'kill', 'kind', 'king', 'knee', 'knew', 'know', 'lack', 'lady', 'laid', 'lake', 'land', 'lane', 'last', 'late', 'lead', 'left', 'less', 'life', 'lift', 'like', 'line', 'link', 'list', 'live', 'load', 'loan', 'lock', 'logo', 'long', 'look', 'lord', 'lose', 'loss', 'lost', 'love', 'luck', 'made', 'mail', 'main', 'make', 'male', 'many', 'mark', 'mass', 'mate', 'math', 'meal', 'mean', 'meat', 'meet', 'menu', 'mere', 'mile', 'milk', 'mill', 'mind', 'mine', 'miss', 'mode', 'mood', 'moon', 'more', 'most', 'move', 'much', 'must', 'name', 'navy', 'near', 'neck', 'need', 'news', 'next', 'nice', 'nick', 'nine', 'none', 'nose', 'note', 'okay', 'once', 'only', 'onto', 'open', 'oral', 'over', 'pace', 'pack', 'page', 'paid', 'pain', 'pair', 'palm', 'park', 'part', 'pass', 'past', 'path', 'peak', 'pick', 'pile', 'pink', 'pipe', 'plan', 'play', 'plot', 'plug', 'plus', 'poll', 'pool', 'poor', 'port', 'post', 'pull', 'pure', 'push', 'race', 'rail', 'rain', 'rank', 'rare', 'rate', 'read', 'real', 'rear', 'rely', 'rent', 'rest', 'rice', 'rich', 'ride', 'ring', 'rise', 'risk', 'road', 'rock', 'role', 'roll', 'roof', 'room', 'root', 'rose', 'rule', 'rush', 'safe', 'said', 'sake', 'sale', 'salt', 'same', 'sand', 'save', 'seat', 'seed', 'seek', 'seem', 'seen', 'self', 'sell', 'send', 'sent', 'ship', 'shop', 'shot', 'show', 'shut', 'sick', 'side', 'sign', 'silk', 'site', 'size', 'skin', 'slip', 'slow', 'snow', 'soft', 'soil', 'sold', 'sole', 'some', 'song', 'soon', 'sort', 'soul', 'spot', 'star', 'stay', 'step', 'stop', 'such', 'suit', 'sure', 'take', 'tale', 'talk', 'tall', 'tank', 'tape', 'task', 'team', 'tech', 'tell', 'tend', 'term', 'test', 'text', 'than', 'that', 'them', 'then', 'they', 'thin', 'this', 'thus', 'till', 'time', 'tiny', 'told', 'toll', 'tone', 'took', 'tool', 'tour', 'town', 'tree', 'trip', 'true', 'tune', 'turn', 'twin', 'type', 'unit', 'upon', 'used', 'user', 'vary', 'vast', 'very', 'vice', 'view', 'vote', 'wage', 'wait', 'wake', 'walk', 'wall', 'want', 'ward', 'warm', 'wash', 'wave', 'ways', 'weak', 'wear', 'week', 'well', 'went', 'were', 'west', 'what', 'when', 'whom', 'wide', 'wife', 'wild', 'will', 'wind', 'wine', 'wing', 'wire', 'wise', 'wish', 'with', 'wood', 'word', 'work', 'yard', 'yeah', 'year', 'your', 'zero', 'zone',
    // 5+ chars (selection)
    'about', 'above', 'abuse', 'actor', 'acute', 'admit', 'adopt', 'adult', 'after', 'again', 'agent', 'agree', 'ahead', 'alarm', 'album', 'alert', 'alike', 'alive', 'allow', 'alone', 'along', 'alter', 'among', 'anger', 'angle', 'angry', 'apart', 'apple', 'apply', 'arena', 'argue', 'arise', 'array', 'aside', 'asset', 'audio', 'audit', 'avoid', 'award', 'aware', 'badly', 'baker', 'bases', 'basic', 'basis', 'beach', 'began', 'begin', 'begun', 'being', 'below', 'bench', 'birth', 'black', 'blame', 'blind', 'block', 'blood', 'board', 'boost', 'booth', 'bound', 'brain', 'brand', 'bread', 'break', 'breed', 'brief', 'bring', 'broad', 'brown', 'brush', 'build', 'built', 'buyer', 'cable', 'carry', 'catch', 'cause', 'chain', 'chair', 'chart', 'chase', 'cheap', 'check', 'chest', 'chief', 'child', 'china', 'chose', 'civil', 'claim', 'class', 'clean', 'clear', 'click', 'clock', 'close', 'coach', 'coast', 'could', 'count', 'court', 'cover', 'craft', 'crash', 'cream', 'crime', 'cross', 'crowd', 'crown', 'curve', 'cycle', 'daily', 'dance', 'dated', 'dealt', 'death', 'debut', 'delay', 'depth', 'doing', 'doubt', 'dozen', 'draft', 'drama', 'drawn', 'dream', 'dress', 'drill', 'drink', 'drive', 'drove', 'dying', 'eager', 'early', 'earth', 'eight', 'elite', 'empty', 'enemy', 'enjoy', 'enter', 'entry', 'equal', 'error', 'event', 'every', 'exact', 'exist', 'extra', 'faith', 'false', 'fault', 'fiber', 'field', 'fifth', 'fifty', 'fight', 'final', 'first', 'fixed', 'flash', 'fleet', 'floor', 'fluid', 'focus', 'force', 'forth', 'forty', 'forum', 'found', 'frame', 'frank', 'fraud', 'fresh', 'front', 'fruit', 'fully', 'funny', 'giant', 'given', 'glass', 'globe', 'going', 'grace', 'grade', 'grand', 'grant', 'grass', 'great', 'green', 'gross', 'group', 'grown', 'guard', 'guess', 'guest', 'guide', 'happy', 'heart', 'heavy', 'hence', 'horse', 'hotel', 'house', 'human', 'ideal', 'image', 'index', 'inner', 'input', 'issue', 'japan', 'joint', 'judge', 'known', 'label', 'large', 'laser', 'later', 'laugh', 'layer', 'learn', 'lease', 'least', 'leave', 'legal', 'level', 'light', 'limit', 'links', 'lives', 'local', 'logic', 'loose', 'lower', 'lucky', 'lunch', 'lying', 'magic', 'major', 'maker', 'march', 'match', 'maybe', 'mayor', 'limit', 'admit', 'adult', 'advice', 'affect', 'afford', 'afraid', 'agency', 'agenda', 'almost', 'always', 'amount', 'animal', 'annual', 'answer', 'anyway', 'appeal', 'appear', 'aspect', 'assist', 'assume', 'attack', 'attend', 'august', 'author', 'avenue', 'backed', 'barely', 'battle', 'beauty', 'became', 'become', 'before', 'behalf', 'behind', 'belief', 'belong', 'berlin', 'better', 'beyond', 'bishop', 'border', 'bottle', 'bottom', 'bought', 'branch', 'breath', 'bridge', 'bright', 'broken', 'budget', 'burden', 'bureau', 'button', 'camera', 'cancer', 'cannot', 'carbon', 'career', 'castle', 'casual', 'caught', 'center', 'centre', 'chance', 'change', 'charge', 'choice', 'choose', 'chosen', 'church', 'circle', 'client', 'closed', 'closer', 'coffee', 'column', 'combat', 'coming', 'common', 'comply', 'copper', 'corner', 'costly', 'county', 'couple', 'course', 'covers', 'create', 'credit'
];

// Initialize
document.addEventListener('DOMContentLoaded', async () => {
    await loadData();
    await checkHelperStatus();
    setupEventListeners();
    setupTheme();
    setupHelperSettings();
    setupOverrideAll();
    render();
    scrollToNow(false); // Initial scroll (instant, no animation)
    startTickInterval();
    detectPlatform();
});

// Check if the helper daemon is available
async function checkHelperStatus() {
    try {
        const status = await tauriAPI.checkHelperStatus();
        // Helper is only considered available if running AND version matches
        helperAvailable = status.running && status.version_ok;
        console.log('Helper status:', status);

        if (status.running && !status.version_ok) {
            console.log('Helper is outdated (version:', status.version, ') - will prompt to update on first block');
        } else if (!status.installed) {
            console.log('Helper not installed - will prompt on first block');
        }
    } catch (err) {
        console.error('Error checking helper status:', err);
        helperAvailable = false;
    }
}

// Load data from main process
async function loadData() {
    appData = await tauriAPI.loadData();
    if (!appData || !appData.blocklists) {
        appData = {
            blocklists: [],
            activeBlocks: [],
            schedules: [],
            settings: { onboardingComplete: false }
        };
    }
    // Ensure schedules array exists for older data
    if (!appData.schedules) {
        appData.schedules = [];
    }
}

// Save data to main process
async function saveData() {
    await tauriAPI.saveData(appData);
}

// Compare semver versions - returns true if versionA > versionB
function isVersionHigher(versionA, versionB) {
    const partsA = versionA.split('.').map(Number);
    const partsB = versionB.split('.').map(Number);

    for (let i = 0; i < Math.max(partsA.length, partsB.length); i++) {
        const a = partsA[i] || 0;
        const b = partsB[i] || 0;
        if (a > b) return true;
        if (a < b) return false;
    }
    return false; // Equal versions
}

// Detect platform for window controls
function detectPlatform() {
    const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0;
    if (isMac) {
        document.body.classList.add('mac');
        // Hide controls on macOS - native traffic lights are used
        document.getElementById('window-controls')?.classList.add('hidden');
    } else {
        document.body.classList.add('windows');
        // Show controls on Windows
        document.getElementById('window-controls')?.classList.remove('hidden');
    }
}

// Update window height to fit content
function updateWindowHeight() {
    // Use requestAnimationFrame to ensure layout is complete
    requestAnimationFrame(() => {
        const appContainer = document.querySelector('.app-container');
        if (appContainer) {
            // Get the actual height needed for the content
            const contentHeight = appContainer.scrollHeight;
            // Add a small buffer for window chrome/borders
            const targetHeight = Math.max(contentHeight + 20, 500);
            // Window height adjustment handled by Tauri
            // tauriAPI.setWindowHeight(targetHeight);
        }
    });
}

// Update maximize button icon based on window state
async function updateMaximizeButton() {
    const maximizeBtn = document.getElementById('titlebar-maximize');
    const maximizeIcon = document.getElementById('maximize-icon');
    const restoreIcon = document.getElementById('restore-icon');

    if (!maximizeBtn || !maximizeIcon || !restoreIcon) return;

    const win = getCurrentWindow();
    const isMaximized = await win.isMaximized();

    if (isMaximized) {
        maximizeIcon.style.display = 'none';
        restoreIcon.style.display = 'block';
        maximizeBtn.title = 'Restore';
    } else {
        maximizeIcon.style.display = 'block';
        restoreIcon.style.display = 'none';
        maximizeBtn.title = 'Maximize';
    }
}

// Setup event listeners
function setupEventListeners() {
    // Window controls (using Tauri docs naming)
    document.getElementById('titlebar-minimize')?.addEventListener('click', () => {
        tauriAPI.minimizeWindow();
    });

    document.getElementById('titlebar-maximize')?.addEventListener('click', async () => {
        await tauriAPI.maximizeWindow();
        // Update icon after state changes
        setTimeout(updateMaximizeButton, 100);
    });

    document.getElementById('titlebar-close')?.addEventListener('click', () => {
        tauriAPI.closeWindow();
    });

    // Initial check for maximize state
    updateMaximizeButton();

    // Check periodically to catch state changes (double-click title bar, etc.)
    // This ensures the icon updates even if window is maximized/restored via other means
    setInterval(updateMaximizeButton, 300);

    // Time pickers - custom popover handlers
    document.querySelectorAll('.time-part').forEach(btn => {
        btn.addEventListener('click', handleTimePartClick);
    });

    // Close popovers on outside click
    document.addEventListener('click', handlePopoverOutsideClick);

    // Click on background to deselect blocklists
    document.addEventListener('click', (e) => {
        // Don't deselect if clicking on interactive elements
        if (e.target.closest('.blocklist-card') ||
            e.target.closest('.scheduler-section') ||
            e.target.closest('.modal-overlay') ||
            e.target.closest('.section-header') ||
            e.target.closest('.footer') ||
            e.target.closest('.title-bar') ||
            e.target.closest('.week-calendar-section') ||
            e.target.closest('.time-popover') ||
            e.target.closest('.time-part')) {
            return;
        }

        // Deselect blocklist if one is selected
        if (selectedBlocklistId) {
            // Save pending changes before deselecting
            const currentBlocklistId = selectedBlocklistId;
            if (isScheduleMode) {
                const existingSchedule = appData.schedules?.find(s => s.blocklistId === currentBlocklistId);
                if (!appData.settings) appData.settings = {};
                if (!appData.settings.pendingScheduleSegments) appData.settings.pendingScheduleSegments = {};

                if (!existingSchedule) {
                    // No active schedule - save all segments
                    if (scheduleSegments.length > 0) {
                        appData.settings.pendingScheduleSegments[currentBlocklistId] = scheduleSegments.map(seg => ({ ...seg }));
                        saveData();
                    }
                } else {
                    // Active schedule exists - save only NEW segments (those beyond activeScheduleSegmentCount)
                    if (scheduleSegments.length > activeScheduleSegmentCount) {
                        const newSegments = scheduleSegments.slice(activeScheduleSegmentCount);
                        appData.settings.pendingScheduleSegments[currentBlocklistId] = newSegments.map(seg => ({ ...seg }));
                        saveData();
                    } else {
                        // No new segments - clear any pending segments
                        if (appData.settings.pendingScheduleSegments[currentBlocklistId]) {
                            delete appData.settings.pendingScheduleSegments[currentBlocklistId];
                            saveData();
                        }
                    }
                }
            } else {
                // Save pending instant block duration if different from default
                if (!appData.settings) appData.settings = {};
                if (!appData.settings.instantBlockDuration) appData.settings.instantBlockDuration = {};
                if (targetDurationMinutes !== 60) {
                    appData.settings.instantBlockDuration[currentBlocklistId] = targetDurationMinutes;
                    saveData();
                }
            }

            selectedBlocklistId = null;
            const blocklistSelect = document.getElementById('blocklist-select');
            blocklistSelect.value = '';
            handleBlocklistSelect({ target: blocklistSelect });
        }
    });

    // Duration picker - input change
    const durationInput = document.getElementById('duration-minutes-input');
    if (durationInput) {
        durationInput.addEventListener('input', (e) => {
            // Enforce max 5 digits visually
            if (durationInput.value.length > 5) {
                durationInput.value = durationInput.value.slice(0, 5);
            }
            handleDurationInputChange();
        });
        durationInput.addEventListener('blur', () => {
            let mins = parseInt(durationInput.value);
            if (isNaN(mins) || mins < 1) mins = 60;
            if (mins > 99999) mins = 99999;
            durationInput.value = mins;
            handleDurationInputChange();
        });
    }

    // Duration picker - quick toggle buttons
    document.querySelectorAll('.duration-quick-btn').forEach(btn => {
        btn.addEventListener('click', handleDurationQuickBtn);
    });

    // Initialize time picker with defaults
    initializeTimeInputs();

    // Blocklist selector
    document.getElementById('blocklist-select').addEventListener('change', handleBlocklistSelect);

    // Start block button
    document.getElementById('start-block-btn').addEventListener('click', startBlock);

    // Add blocklist button
    document.getElementById('add-blocklist-btn').addEventListener('click', () => openBlocklistModal());

    // Onboarding
    setupOnboardingListeners();

    // Modal listeners
    setupModalListeners();

    // Override modal
    setupOverrideModalListeners();

    // Undo toast button
    document.getElementById('undo-toast-btn')?.addEventListener('click', undoDelete);

    // Helper install modal buttons
    document.getElementById('cancel-helper-install-btn')?.addEventListener('click', () => {
        document.getElementById('helper-install-modal').classList.add('hidden');
        pendingBlockData = null;
    });

    document.getElementById('proceed-helper-install-btn')?.addEventListener('click', proceedWithHelperInstall);

    // Start block confirmation modal buttons
    document.getElementById('cancel-start-confirm-btn')?.addEventListener('click', closeStartBlockConfirmModal);
    document.getElementById('proceed-start-confirm-btn')?.addEventListener('click', proceedWithBlock);

    // Schedule confirmation modal buttons
    document.getElementById('cancel-schedule-confirm-btn')?.addEventListener('click', closeScheduleConfirmModal);
    document.getElementById('proceed-schedule-confirm-btn')?.addEventListener('click', proceedWithSchedule);

    // Week calendar navigation buttons
    document.getElementById('prev-week-btn')?.addEventListener('click', () => navigateWeek(-1));
    document.getElementById('next-week-btn')?.addEventListener('click', () => navigateWeek(1));
    document.getElementById('today-btn')?.addEventListener('click', () => scrollToToday());

    // Schedule mode tabs
    document.getElementById('instant-mode-tab')?.addEventListener('click', () => setScheduleMode(false));
    document.getElementById('schedule-mode-tab')?.addEventListener('click', () => setScheduleMode(true));

    // Add segment button
    document.getElementById('add-segment-btn')?.addEventListener('click', addScheduleSegment);

    // Start schedule button
    document.getElementById('start-schedule-btn')?.addEventListener('click', startSchedule);

    // Repeat dropdown (renamed from Until)
    document.getElementById('repeat-dropdown-btn')?.addEventListener('click', toggleRepeatDropdown);
    document.querySelectorAll('.repeat-option').forEach(opt => {
        opt.addEventListener('click', handleRepeatOptionClick);
    });
    document.getElementById('repeat-date-input')?.addEventListener('change', handleRepeatDateChange);

    // Initialize first segment day toggles
    document.querySelectorAll('.segment-day-toggle').forEach(btn => {
        btn.addEventListener('click', () => {
            const segmentIndex = parseInt(btn.closest('.segment-days').dataset.segmentIndex);
            const dayIndex = parseInt(btn.dataset.day);
            handleSegmentDayToggle(segmentIndex, dayIndex, btn);
        });
    });

    // Week calendar scroll handling with day snap
    const calendarScroll = document.querySelector('.week-calendar-scroll');
    if (calendarScroll) {
        let scrollTimeout;
        calendarScroll.addEventListener('scroll', () => {
            clearTimeout(scrollTimeout);
            scrollTimeout = setTimeout(() => {
                // Update the visible date range display
                updateVisibleRangeDisplay();
            }, 150);
        });

        // Click on calendar (not on block) scrolls to today
        calendarScroll.addEventListener('click', (e) => {
            if (!e.target.closest('.calendar-block')) {
                scrollToToday();
            }
        });
    }

    // Listen for blocks updated from main process
    tauriAPI.onBlocksUpdated(async () => {
        await loadData();
        render();
    });
}

// Onboarding listeners
function setupOnboardingListeners() {
    const websiteInput = document.getElementById('website-input');
    const appInput = document.getElementById('app-input');
    const websitesTags = document.getElementById('websites-tags');
    const appsTags = document.getElementById('apps-tags');

    let onboardingWebsites = [];
    let onboardingApps = [];

    websiteInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && websiteInput.value.trim()) {
            e.preventDefault();
            const website = websiteInput.value.trim().toLowerCase();
            if (!onboardingWebsites.includes(website)) {
                onboardingWebsites.push(website);
                renderTags(websitesTags, onboardingWebsites, (idx) => {
                    onboardingWebsites.splice(idx, 1);
                    renderTags(websitesTags, onboardingWebsites);
                });
            }
            websiteInput.value = '';
        }
    });

    appInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && appInput.value.trim()) {
            e.preventDefault();
            const app = appInput.value.trim();
            if (!onboardingApps.includes(app)) {
                onboardingApps.push(app);
                renderTags(appsTags, onboardingApps, (idx) => {
                    onboardingApps.splice(idx, 1);
                    renderTags(appsTags, onboardingApps);
                });
            }
            appInput.value = '';
        }
    });

    // Browse button for onboarding
    document.getElementById('browse-apps-btn')?.addEventListener('click', async () => {
        const appName = await tauriAPI.openAppPicker();
        if (appName && !onboardingApps.includes(appName)) {
            onboardingApps.push(appName);
            renderTags(appsTags, onboardingApps, (idx) => {
                onboardingApps.splice(idx, 1);
                renderTags(appsTags, onboardingApps);
            });
        }
    });

    document.getElementById('create-first-blocklist-btn').addEventListener('click', () => {
        // Auto-confirm any pending input in the website/app fields
        const pendingWebsite = websiteInput.value.trim().toLowerCase();
        if (pendingWebsite && !onboardingWebsites.includes(pendingWebsite)) {
            onboardingWebsites.push(pendingWebsite);
            websiteInput.value = '';
            renderTags(websitesTags, onboardingWebsites, (idx) => {
                onboardingWebsites.splice(idx, 1);
                renderTags(websitesTags, onboardingWebsites);
            });
        }

        const pendingApp = appInput.value.trim();
        if (pendingApp && !onboardingApps.includes(pendingApp)) {
            onboardingApps.push(pendingApp);
            appInput.value = '';
            renderTags(appsTags, onboardingApps, (idx) => {
                onboardingApps.splice(idx, 1);
                renderTags(appsTags, onboardingApps);
            });
        }

        const name = document.getElementById('first-blocklist-name').value.trim();
        if (!name) {
            alert('Please enter a name for your blocklist');
            return;
        }
        if (onboardingWebsites.length === 0 && onboardingApps.length === 0) {
            alert('Please add at least one website or app to block');
            return;
        }

        const blocklist = {
            id: generateId(),
            name,
            mode: 'blocklist',
            websites: onboardingWebsites,
            apps: onboardingApps,
            overrideDifficulty: {
                type: 'random-words',
                count: 50
            }
        };

        appData.blocklists.push(blocklist);
        appData.settings.onboardingComplete = true;
        saveData();

        // Resize window from onboarding size to main app size
        tauriAPI.setWindowSize(840, 650);

        render();
    });
}

// Modal listeners
function setupModalListeners() {
    let modalWebsites = [];
    let modalApps = [];

    const modalWebsiteInput = document.getElementById('modal-website-input');
    const modalAppInput = document.getElementById('modal-app-input');
    const modalWebsitesTags = document.getElementById('modal-websites-tags');
    const modalAppsTags = document.getElementById('modal-apps-tags');

    // Close modal when clicking outside content
    document.getElementById('blocklist-modal').addEventListener('click', (e) => {
        if (e.target.classList.contains('modal-overlay')) {
            closeBlocklistModal();
        }
    });

    modalWebsiteInput.addEventListener('keydown', (e) => {
        // Enter or Space confirms the website (domains can't have spaces)
        if ((e.key === 'Enter' || e.key === ' ') && modalWebsiteInput.value.trim()) {
            e.preventDefault();
            const website = modalWebsiteInput.value.trim().toLowerCase();
            if (!modalWebsites.includes(website)) {
                modalWebsites.push(website);
                window.renderModalTags();
            }
            modalWebsiteInput.value = '';
        }
    });

    modalAppInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && modalAppInput.value.trim()) {
            e.preventDefault();
            const app = modalAppInput.value.trim();
            if (!modalApps.includes(app)) {
                modalApps.push(app);
                window.renderModalTags();
            }
            modalAppInput.value = '';
        }
    });

    // Browse button for modal
    document.getElementById('modal-browse-apps-btn')?.addEventListener('click', async () => {
        const appNames = await tauriAPI.openAppPicker();
        if (appNames && appNames.length > 0) {
            let added = false;
            for (const appName of appNames) {
                if (!modalApps.includes(appName)) {
                    modalApps.push(appName);
                    added = true;
                }
            }
            if (added) {
                window.renderModalTags();
            }
        }
    });
    // Override type
    document.getElementById('override-type').addEventListener('change', (e) => {
        const type = e.target.value;
        const customTextArea = document.getElementById('custom-override-text');
        const overrideCountWrapper = document.getElementById('override-count-wrapper');
        const hintEl = document.getElementById('override-count-hint');

        if (type === 'custom') {
            customTextArea.classList.remove('hidden');
            overrideCountWrapper.classList.add('hidden');
            hintEl.classList.add('hidden');
        } else {
            customTextArea.classList.add('hidden');
            overrideCountWrapper.classList.remove('hidden');
            hintEl.classList.remove('hidden');

            if (type === 'random-words') {
                hintEl.innerHTML = "E.g. 10 chars → 'shine great'";
            } else {
                hintEl.innerHTML = "E.g. 10 chars → 'a982j3+fd'";
            }
        }
    });

    // Override count blur on enter
    document.getElementById('override-count').addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.target.blur();
        }
    });

    // Color swatches
    document.querySelectorAll('.color-swatch').forEach(swatch => {
        swatch.addEventListener('click', () => {
            document.querySelectorAll('.color-swatch').forEach(s => s.classList.remove('selected'));
            swatch.classList.add('selected');
        });
    });

    // Custom color picker
    const customColorInput = document.getElementById('custom-color-input');
    const customSwatch = document.getElementById('custom-color-swatch');
    if (customColorInput && customSwatch) {
        // Trigger input when swatch is clicked
        customSwatch.addEventListener('click', () => {
            customColorInput.click();
        });

        customColorInput.addEventListener('input', (e) => {
            const color = e.target.value;
            customSwatch.style.background = color;
            customSwatch.dataset.color = color;
            document.querySelectorAll('.color-swatch').forEach(s => s.classList.remove('selected'));
            customSwatch.classList.add('selected');
        });
    }

    // Emoji swatches
    document.querySelectorAll('.emoji-swatch').forEach(swatch => {
        swatch.addEventListener('click', () => {
            // Only handle non-custom swatches here, or custom swatches if they already have an emoji
            if (!swatch.classList.contains('custom-emoji-swatch') || swatch.dataset.emoji) {
                document.querySelectorAll('.emoji-swatch').forEach(s => s.classList.remove('selected'));
                swatch.classList.add('selected');
            }
        });
    });

    // Custom emoji picker with emoji-picker-element popover
    const customEmojiSwatch = document.getElementById('custom-emoji-swatch');
    const emojiPickerPopover = document.getElementById('emoji-picker-popover');
    const emojiPicker = emojiPickerPopover?.querySelector('emoji-picker');

    if (customEmojiSwatch && emojiPickerPopover && emojiPicker) {
        // Toggle popover on swatch click
        customEmojiSwatch.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();

            if (emojiPickerPopover.classList.contains('hidden')) {
                // Position the popover above the button using fixed positioning
                const rect = customEmojiSwatch.getBoundingClientRect();
                emojiPickerPopover.style.bottom = (window.innerHeight - rect.top + 8) + 'px';
                emojiPickerPopover.style.right = (window.innerWidth - rect.right) + 'px';
                emojiPickerPopover.classList.remove('hidden');
            } else {
                emojiPickerPopover.classList.add('hidden');
            }
        });

        // Handle emoji selection
        emojiPicker.addEventListener('emoji-click', (e) => {
            const emoji = e.detail.unicode;
            customEmojiSwatch.innerHTML = emoji;
            customEmojiSwatch.dataset.emoji = emoji;

            // Select the custom swatch
            document.querySelectorAll('.emoji-swatch').forEach(s => s.classList.remove('selected'));
            customEmojiSwatch.classList.add('selected');

            // Hide popover
            emojiPickerPopover.classList.add('hidden');
        });

        // Close popover when clicking outside
        document.addEventListener('click', (e) => {
            if (!emojiPickerPopover.classList.contains('hidden') &&
                !emojiPickerPopover.contains(e.target) &&
                !customEmojiSwatch.contains(e.target)) {
                emojiPickerPopover.classList.add('hidden');
            }
        });
    }

    // Blocklist modal advanced options toggle
    const blocklistAdvancedToggle = document.getElementById('blocklist-advanced-toggle');
    const blocklistAdvancedContent = document.getElementById('blocklist-advanced-content');
    if (blocklistAdvancedToggle && blocklistAdvancedContent) {
        blocklistAdvancedToggle.addEventListener('click', () => {
            blocklistAdvancedToggle.classList.toggle('expanded');
            blocklistAdvancedContent.classList.toggle('hidden');
        });
    }

    // Cancel button
    document.getElementById('cancel-blocklist-btn').addEventListener('click', () => {
        closeBlocklistModal();
    });

    // Save button
    document.getElementById('save-blocklist-btn').addEventListener('click', () => {
        // Auto-confirm any pending input in the website/app fields
        const pendingWebsite = modalWebsiteInput.value.trim().toLowerCase();
        if (pendingWebsite && !modalWebsites.includes(pendingWebsite)) {
            modalWebsites.push(pendingWebsite);
            modalWebsiteInput.value = '';
            window.renderModalTags();
        }

        const pendingApp = modalAppInput.value.trim();
        if (pendingApp && !modalApps.includes(pendingApp)) {
            modalApps.push(pendingApp);
            modalAppInput.value = '';
            window.renderModalTags();
        }

        const name = document.getElementById('blocklist-name').value.trim();
        if (!name) {
            alert('Please enter a name');
            return;
        }

        const mode = 'blocklist'; // Allowlist mode not yet implemented
        const overrideType = document.getElementById('override-type').value;
        const overrideCount = parseInt(document.getElementById('override-count').value) || 10;
        const customText = document.getElementById('custom-override-text').value;
        const selectedSwatch = document.querySelector('.color-swatch.selected');
        const color = selectedSwatch ? selectedSwatch.dataset.color : null;
        const selectedEmoji = document.querySelector('.emoji-swatch.selected');
        const emoji = selectedEmoji ? selectedEmoji.dataset.emoji : '🚫';

        const showItemDetails = document.getElementById('show-item-details-checkbox').checked;
        const alwaysShowInSchedule = document.getElementById('always-show-in-schedule-checkbox').checked;

        // IMPORTANT: Create copies of the arrays, not references!
        const blocklist = {
            id: editingBlocklistId || generateId(),
            name,
            mode,
            color,
            emoji,
            websites: [...modalWebsites],  // Copy the array
            apps: [...modalApps],          // Copy the array
            showItemDetails,
            alwaysShowInSchedule,
            overrideDifficulty: {
                type: overrideType,
                count: overrideCount,
                customText: overrideType === 'custom' ? customText : undefined
            }
        };

        if (editingBlocklistId) {
            const idx = appData.blocklists.findIndex(bl => bl.id === editingBlocklistId);
            if (idx !== -1) {
                appData.blocklists[idx] = blocklist;
            }
        } else {
            appData.blocklists.push(blocklist);
        }

        saveData();

        // If this blocklist is active (block or schedule), update blocking rules immediately
        const now = Date.now();
        const hasActiveBlock = appData.activeBlocks.some(
            b => b.blocklistId === blocklist.id && b.startTime <= now && b.endTime > now
        );
        const hasActiveSchedule = appData.schedules?.some(
            s => s.blocklistId === blocklist.id && s.segments && s.segments.length > 0
        );

        if (hasActiveBlock || hasActiveSchedule) {
            // Update website blocking
            updateHostsFile();

            // Update app blocking - this handles both active blocks and schedules
            updateBlockedApps();
        }

        closeBlocklistModal();

        // Only update blocklist display without resetting schedule segments
        renderBlocklists();
        renderBlocklistSelector();
        renderWeekBlocks(); // Refresh calendar to apply alwaysShowInSchedule changes
        // Re-render the schedule preview to reflect any blocklist changes
        if (isScheduleMode && selectedBlocklistId) {
            handleTimeChange();
        }
    });

    // Store references for modal functions
    window.modalWebsites = modalWebsites;
    window.modalApps = modalApps;
    window.lockedWebsites = [];
    window.lockedApps = [];

    window.renderModalTags = () => {
        renderTags(modalWebsitesTags, modalWebsites, (idx) => {
            modalWebsites.splice(idx, 1);
            window.renderModalTags();
        }, window.lockedWebsites);

        renderTags(modalAppsTags, modalApps, (idx) => {
            modalApps.splice(idx, 1);
            window.renderModalTags();
        }, window.lockedApps);
    };

    window.setModalData = (websites, apps, lockedWebsitesList = [], lockedAppsList = []) => {
        modalWebsites.length = 0;
        modalApps.length = 0;
        window.lockedWebsites = lockedWebsitesList;
        window.lockedApps = lockedAppsList;

        websites.forEach(w => modalWebsites.push(w));
        apps.forEach(a => modalApps.push(a));
        window.renderModalTags();
    };
}

// Override modal listeners
function setupOverrideModalListeners() {
    const challengeInput = document.getElementById('challenge-input');
    const progressBar = document.getElementById('challenge-progress-bar');
    const challengeTextEl = document.getElementById('challenge-text');

    // Helper to render challenge text with optional error highlight
    function renderChallengeText(errorIndex = -1) {
        if (errorIndex < 0 || errorIndex >= challengeText.length) {
            challengeTextEl.textContent = challengeText;
        } else {
            // Highlight the error character
            const before = escapeHtml(challengeText.slice(0, errorIndex));
            const errorChar = escapeHtml(challengeText[errorIndex]);
            const after = escapeHtml(challengeText.slice(errorIndex + 1));
            challengeTextEl.innerHTML = `${before}<span class="error-char">${errorChar}</span>${after}`;
        }
    }

    // Prevent paste - users must type manually
    challengeInput.addEventListener('paste', (e) => {
        e.preventDefault();
    });

    challengeInput.addEventListener('input', () => {
        const typed = challengeInput.value;
        const target = challengeText;

        // Calculate progress and find first error
        let correctChars = 0;
        let firstErrorIndex = -1;
        for (let i = 0; i < typed.length && i < target.length; i++) {
            if (typed[i] === target[i]) {
                correctChars++;
            } else {
                firstErrorIndex = i;
                break; // Stop at first mismatch
            }
        }

        const progress = (correctChars / target.length) * 100;
        progressBar.style.width = `${progress}%`;

        // Clear error highlighting while typing
        renderChallengeText(-1);
    });

    // Enter key submits the override
    challengeInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault(); // Prevent newline in textarea
            document.getElementById('confirm-override-btn').click();
        }
    });

    document.getElementById('cancel-override-btn').addEventListener('click', () => {
        // Check for helper removal special case
        if (overrideBlockId === 'helper-removal' && window.helperRemovalCancelCallback) {
            window.helperRemovalCancelCallback();
            return;
        }
        closeOverrideModal();
    });

    document.getElementById('confirm-override-btn').addEventListener('click', async () => {
        const typed = challengeInput.value;
        const target = challengeText;

        // Find first mismatch
        let firstErrorIndex = -1;
        if (typed !== target) {
            for (let i = 0; i < Math.max(typed.length, target.length); i++) {
                if (typed[i] !== target[i]) {
                    firstErrorIndex = i;
                    break;
                }
            }
            // If typed is shorter than target, first missing char is the error
            if (firstErrorIndex === -1 && typed.length < target.length) {
                firstErrorIndex = typed.length;
            }
        }

        if (typed === target && (overrideBlockId || window.overrideScheduleId)) {
            // Check for helper removal special case
            if (overrideBlockId === 'helper-removal' && window.helperRemovalConfirmCallback) {
                window.helperRemovalConfirmCallback();
                return;
            }

            if (overrideBlockId && overrideBlockId !== 'helper-removal') {
                // Block override - remove the block
                appData.activeBlocks = appData.activeBlocks.filter(b => b.id !== overrideBlockId);
                await saveData();

                // Always try the helper first (it should be running after initial block was started)
                // Re-check helper status in case it was installed this session
                const status = await tauriAPI.checkHelperStatus();
                if (status.running) {
                    helperAvailable = true;
                    await tauriAPI.clearBlockViaHelper();
                } else {
                    // Fallback to direct update only if helper truly not running
                    await updateHostsFile();
                }

                // Update blocked apps (will stop watcher if no apps to block, including schedules)
                await updateBlockedApps();
            } else if (window.overrideScheduleId) {
                // Check which radio button is selected
                const overrideType = document.querySelector('input[name="schedule-override-type"]:checked')?.value || 'stop-schedule';
                const scheduleId = window.overrideScheduleId;
                const segmentIndex = window.overrideSegmentIndex;
                const segmentDay = window.overrideSegmentDay;

                // Only allow "just this block" if segmentIndex and segmentDay are defined
                // (i.e., only when clicking a specific block in the timeline, not from stop schedule button)
                if (overrideType === 'just-this' && segmentIndex !== undefined && segmentDay !== undefined) {
                    // "Just this block" - remove only the specific day from the segment
                    const schedule = appData.schedules.find(s => s.id === scheduleId);
                    if (schedule && schedule.segments[segmentIndex]) {
                        const segment = schedule.segments[segmentIndex];
                        // Remove this day from the segment
                        segment.days = segment.days.filter(d => d !== segmentDay);

                        // If segment has no more days, remove the entire segment
                        if (segment.days.length === 0) {
                            schedule.segments.splice(segmentIndex, 1);
                        }

                        // If schedule has no more segments, remove the entire schedule
                        if (schedule.segments.length === 0) {
                            appData.schedules = appData.schedules.filter(s => s.id !== scheduleId);
                            activeScheduleSegmentCount = 0;
                        }
                    }
                } else {
                    // "Stop schedule" - remove the entire schedule but preserve segments
                    const scheduleToStop = appData.schedules.find(s =>
                        s.id === scheduleId || s.blocklistId === scheduleId
                    );

                    if (scheduleToStop) {
                        // Load all segments from the stopped schedule into scheduleSegments
                        // so they become editable (not greyed out)
                        scheduleSegments = scheduleToStop.segments.map(seg => ({ ...seg }));
                        activeScheduleSegmentCount = 0; // No segments are locked anymore

                        // Save these segments as pending so they persist when clicking off/on
                        if (!appData.settings) appData.settings = {};
                        if (!appData.settings.pendingScheduleSegments) appData.settings.pendingScheduleSegments = {};
                        appData.settings.pendingScheduleSegments[scheduleToStop.blocklistId] = scheduleSegments.map(seg => ({ ...seg }));

                        // Remove the schedule from active schedules
                        appData.schedules = appData.schedules.filter(s =>
                            s.id !== scheduleId && s.blocklistId !== scheduleId
                        );

                        // Rebuild UI to show all segments as editable if we're viewing this blocklist
                        if (selectedBlocklistId === scheduleToStop.blocklistId && isScheduleMode) {
                            rebuildScheduleSegments();
                            disableScheduleControls(false); // Enable all controls
                        }
                    } else {
                        activeScheduleSegmentCount = 0;
                    }
                }

                await saveData();
                await updateHostsFile();
                // Update blocked apps after schedule changes
                await updateBlockedApps();

                // Reset modal title
                const titleEl = document.getElementById('override-modal-title');
                if (titleEl) {
                    titleEl.textContent = 'Override Block?';
                }

                // Hide radio options and reset for next use
                document.getElementById('schedule-override-options').classList.add('hidden');

                delete window.overrideScheduleId;
                delete window.overrideSegmentIndex;
                delete window.overrideSegmentDay;
            }

            render();

            // Refresh the blocklist selection UI to update button and controls
            const blocklistSelect = document.getElementById('blocklist-select');
            handleBlocklistSelect({ target: blocklistSelect });

            closeOverrideModal();
        } else {
            // Wrong! Wiggle and highlight error
            const modalContent = document.querySelector('#override-modal .modal-content');
            modalContent.classList.remove('wiggle');
            void modalContent.offsetWidth; // Trigger reflow
            modalContent.classList.add('wiggle');

            // Highlight first wrong character
            renderChallengeText(firstErrorIndex);
        }
    });

    // Click outside to close
    const overrideModal = document.getElementById('override-modal');
    overrideModal.addEventListener('click', (e) => {
        if (e.target === overrideModal) {
            closeOverrideModal();
        }
    });
}

// Render tags
function renderTags(container, items, onRemove, lockedItems = []) {
    container.innerHTML = items.map((item, idx) => {
        const isLocked = lockedItems.includes(item);
        const lockedClass = isLocked ? 'locked' : '';
        const removeBtn = !isLocked ? `<button class="tag-remove" data-idx="${idx}">×</button>` : '';

        return `
    <span class="tag ${lockedClass}">
      ${escapeHtml(item)}
      ${removeBtn}
    </span>
  `;
    }).join('');

    container.querySelectorAll('.tag-remove').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const idx = parseInt(btn.dataset.idx);
            if (onRemove) onRemove(idx);
        });
    });
}
// Track current selected end time only (start is always 'now')
let selectedEndHour = 20;
let selectedEndMinute = 30;
let targetDurationMinutes = 60; // Default 60-minute block
let userEditedEndTime = false; // Track if user manually changed end time

// Pad number with leading zero
function pad(num) {
    return num.toString().padStart(2, '0');
}

// Disable or enable time controls (when a block is active, controls should be disabled)
function disableTimeControls(disabled) {
    const durationInput = document.getElementById('duration-minutes-input');
    const endHourBtn = document.getElementById('end-hour-btn');
    const endMinuteBtn = document.getElementById('end-minute-btn');
    const endTimeDisplay = document.getElementById('end-time-display');
    const quickSelectBtns = document.querySelectorAll('.duration-quick-btn');
    const timePickerContainer = document.getElementById('time-picker-container');

    if (durationInput) {
        durationInput.disabled = disabled;
        durationInput.style.opacity = disabled ? '0.5' : '1';
        durationInput.style.pointerEvents = disabled ? 'none' : 'auto';
    }

    if (endHourBtn) {
        endHourBtn.disabled = disabled;
        endHourBtn.style.opacity = disabled ? '0.5' : '1';
        endHourBtn.style.pointerEvents = disabled ? 'none' : 'auto';
    }

    if (endMinuteBtn) {
        endMinuteBtn.disabled = disabled;
        endMinuteBtn.style.opacity = disabled ? '0.5' : '1';
        endMinuteBtn.style.pointerEvents = disabled ? 'none' : 'auto';
    }

    if (endTimeDisplay) {
        endTimeDisplay.style.pointerEvents = disabled ? 'none' : 'auto';
    }

    quickSelectBtns.forEach(function (btn) {
        btn.disabled = disabled;
        btn.style.opacity = disabled ? '0.5' : '1';
        btn.style.pointerEvents = disabled ? 'none' : 'auto';
    });

    // Add a visual indicator to the whole container
    if (timePickerContainer) {
        timePickerContainer.classList.toggle('controls-disabled', disabled);
    }
}

// Disable or enable schedule controls (when a schedule is active)
function disableScheduleControls(disabled) {
    const repeatDropdown = document.getElementById('schedule-repeat-select');
    const addSegmentBtn = document.getElementById('add-segment-btn');
    const repeatDropdownBtn = document.getElementById('repeat-dropdown-btn');
    const repeatLabel = document.querySelector('.repeat-label');
    const repeatSection = document.getElementById('schedule-repeat-section');

    // Disable repeat dropdown button and label
    if (repeatDropdownBtn) {
        repeatDropdownBtn.disabled = disabled;
        repeatDropdownBtn.style.pointerEvents = disabled ? 'none' : 'auto';
        repeatDropdownBtn.style.cursor = disabled ? 'default' : 'pointer';
        if (disabled) {
            repeatDropdownBtn.classList.add('repeat-dropdown-disabled');
        } else {
            repeatDropdownBtn.classList.remove('repeat-dropdown-disabled');
        }
    }

    // Style repeat label
    if (repeatLabel) {
        if (disabled) {
            repeatLabel.classList.add('repeat-label-disabled');
        } else {
            repeatLabel.classList.remove('repeat-label-disabled');
        }
    }

    // Disable Add button when schedule is active (activeScheduleSegmentCount > 0)
    if (addSegmentBtn) {
        const isScheduleActive = activeScheduleSegmentCount > 0;
        addSegmentBtn.disabled = isScheduleActive;
        addSegmentBtn.style.opacity = isScheduleActive ? '0.5' : '1';
        addSegmentBtn.style.pointerEvents = isScheduleActive ? 'none' : 'auto';
        addSegmentBtn.style.cursor = isScheduleActive ? 'not-allowed' : 'pointer';
    }

    // Disable controls on EXISTING segments (those within activeScheduleSegmentCount)
    document.querySelectorAll('.schedule-segment').forEach((segment, index) => {
        const isExistingSegment = index < activeScheduleSegmentCount;

        if (disabled && isExistingSegment) {
            // Disable this segment's controls
            segment.querySelectorAll('.time-part, .segment-day-toggle, .remove-segment-btn').forEach(el => {
                el.disabled = true;
                el.style.opacity = '0.5';
                el.style.pointerEvents = 'none';
            });
            segment.classList.add('segment-locked');
        } else {
            // Enable this segment's controls
            segment.querySelectorAll('.time-part, .segment-day-toggle, .remove-segment-btn').forEach(el => {
                el.disabled = false;
                el.style.opacity = '1';
                el.style.pointerEvents = 'auto';
            });
            segment.classList.remove('segment-locked');
        }
    });
}

// Initialize time picker with popover options (end time only)
function initializeTimeInputs() {
    const now = new Date();

    // Reset editing flag and load saved duration for this blocklist (or default to 60)
    userEditedEndTime = false;
    if (selectedBlocklistId && appData.settings?.instantBlockDuration?.[selectedBlocklistId] !== undefined) {
        targetDurationMinutes = appData.settings.instantBlockDuration[selectedBlocklistId];
    } else {
        targetDurationMinutes = 60;
    }

    // End time = now + target duration
    const endTime = new Date(now.getTime() + targetDurationMinutes * 60 * 1000);
    selectedEndHour = endTime.getHours();
    selectedEndMinute = endTime.getMinutes();

    // Populate hour options (0-23) for end time only
    const hourContainer = document.getElementById('end-hour-options');
    if (hourContainer) {
        hourContainer.innerHTML = '';
        for (let h = 0; h < 24; h++) {
            const btn = document.createElement('button');
            btn.className = 'popover-option';
            btn.textContent = pad(h);
            btn.dataset.value = h;
            btn.dataset.type = 'hour';
            btn.dataset.target = 'end';
            btn.addEventListener('click', selectTimeOption);
            hourContainer.appendChild(btn);
        }
    }

    // Populate minute options (0-59) for end time only
    const minuteContainer = document.getElementById('end-minute-options');
    if (minuteContainer) {
        minuteContainer.innerHTML = '';
        for (let m = 0; m < 60; m++) {
            const btn = document.createElement('button');
            btn.className = 'popover-option';
            btn.textContent = pad(m);
            btn.dataset.value = m;
            btn.dataset.type = 'minute';
            btn.dataset.target = 'end';
            btn.addEventListener('click', selectTimeOption);
            minuteContainer.appendChild(btn);
        }
    }

    // Update displays
    updateTimeDisplay();
    handleTimeChange();

    // Initialize click handlers for schedule segment time buttons
    document.querySelectorAll('.schedule-block-panel .time-part').forEach(btn => {
        btn.addEventListener('click', handleScheduleTimeClick);
    });
}

// Update the time display buttons (end time only)
function updateTimeDisplay() {
    const endHourBtn = document.getElementById('end-hour-btn');
    const endMinuteBtn = document.getElementById('end-minute-btn');
    if (endHourBtn) endHourBtn.textContent = pad(selectedEndHour);
    if (endMinuteBtn) endMinuteBtn.textContent = pad(selectedEndMinute);

    // Update selected state in popovers
    updatePopoverSelection();
}

// Update selected state in popover options (end time only)
function updatePopoverSelection() {
    // Clear all selections
    document.querySelectorAll('.popover-option').forEach(btn => btn.classList.remove('selected'));

    // Mark current end time selections
    document.querySelectorAll('#end-hour-options .popover-option').forEach(btn => {
        if (parseInt(btn.dataset.value) === selectedEndHour) btn.classList.add('selected');
    });
    document.querySelectorAll('#end-minute-options .popover-option').forEach(btn => {
        if (parseInt(btn.dataset.value) === selectedEndMinute) btn.classList.add('selected');
    });
}

// Handle click on time part button
function handleTimePartClick(e) {
    e.stopPropagation();
    const btn = e.currentTarget;
    const type = btn.dataset.type;
    const target = btn.dataset.target;

    // Close all popovers first
    closeAllPopovers();

    // Open the relevant popover
    const popover = document.getElementById(`${target}-${type}-popover`);
    popover.classList.remove('hidden');
    btn.classList.add('active');

    // Scroll to selected option
    const selectedOption = popover.querySelector('.popover-option.selected');
    if (selectedOption) {
        selectedOption.scrollIntoView({ block: 'center', behavior: 'instant' });
    }
}



// Select a time option from popover (end time only)
function selectTimeOption(e) {
    e.stopPropagation();
    const btn = e.currentTarget;
    const value = parseInt(btn.dataset.value);
    const type = btn.dataset.type;

    // User manually edited end time
    userEditedEndTime = true;

    // Update end time values
    if (type === 'hour') selectedEndHour = value;
    else selectedEndMinute = value;

    // Update display and close popover
    updateTimeDisplay();
    closeAllPopovers();
    handleTimeChange();
}


// Close all popovers
function closeAllPopovers() {
    document.querySelectorAll('.time-popover').forEach(p => p.classList.add('hidden'));
    document.querySelectorAll('.time-part').forEach(btn => btn.classList.remove('active'));
}

// Handle clicks outside popovers
function handlePopoverOutsideClick(e) {
    if (!e.target.closest('.time-popover') && !e.target.closest('.time-part')) {
        closeAllPopovers();
    }
}

// Get start time as Date (always now, with seconds zeroed for consistent duration calculation)
function getStartTimeAsDate() {
    const now = new Date();
    now.setSeconds(0, 0); // Zero out seconds and milliseconds to match end time format
    return now;
}

// Get end time as Date
function getEndTimeAsDate() {
    const date = new Date();
    date.setHours(selectedEndHour, selectedEndMinute, 0, 0);
    return date;
}

// Get smart label for start time relative to now
function getStartTimeLabel(startTime) {
    const now = new Date();
    const diffMs = startTime.getTime() - now.getTime();
    const diffMins = Math.round(diffMs / 60000);

    if (diffMins <= 1) {
        return 'Now';
    } else if (diffMins < 60) {
        return `in ${diffMins} min`;
    } else {
        const hours = Math.floor(diffMins / 60);
        const mins = diffMins % 60;
        if (mins === 0) {
            return `in ${hours}h`;
        } else {
            return `in ${hours}h ${mins}m`;
        }
    }
}

// Handle duration input change - update end time accordingly
function handleDurationInputChange() {
    const input = document.getElementById('duration-minutes-input');
    const val = input.value;

    // Don't clamp while typing - allow it to be empty
    if (val === '') return;

    let mins = parseInt(val);
    if (isNaN(mins) || mins <= 0) return;

    // Track the target duration and reset end time editing flag
    targetDurationMinutes = Math.min(mins, 99999);
    userEditedEndTime = false;

    // Only update end time if it's a valid positive number
    const startTime = getStartTimeAsDate();
    const newEndTime = new Date(startTime.getTime() + targetDurationMinutes * 60 * 1000);

    selectedEndHour = newEndTime.getHours();
    selectedEndMinute = newEndTime.getMinutes();

    updateTimeDisplay();
    updateDurationQuickBtns(targetDurationMinutes);
    handleTimeChange();
}

// Handle duration quick toggle button click
function handleDurationQuickBtn(e) {
    const mins = parseInt(e.target.dataset.mins);
    const input = document.getElementById('duration-minutes-input');
    input.value = mins;

    // Track the target duration and reset end time editing flag
    targetDurationMinutes = mins;
    userEditedEndTime = false;

    // Calculate new end time based on start + duration
    const startTime = getStartTimeAsDate();
    const newEndTime = new Date(startTime.getTime() + mins * 60 * 1000);

    selectedEndHour = newEndTime.getHours();
    selectedEndMinute = newEndTime.getMinutes();

    updateTimeDisplay();
    updateDurationQuickBtns(mins);
    handleTimeChange();
}

// Update quick button active states based on current duration
function updateDurationQuickBtns(durationMinutes) {
    document.querySelectorAll('.duration-quick-btn').forEach(btn => {
        const btnMins = parseInt(btn.dataset.mins);
        if (btnMins === durationMinutes) {
            btn.classList.add('active');
        } else {
            btn.classList.remove('active');
        }
    });
}

// ========================================
// SCHEDULE MODE FUNCTIONS
// ========================================

// Get default schedule segments based on current time
// Start at the current hour (floor), end 2 hours later
function getDefaultScheduleSegments() {
    const now = new Date();
    const startHour = now.getHours();
    const endHour = (startHour + 2) % 24;
    // Get current day (0=Sun...6=Sat in JS, convert to 0=Mon...6=Sun)
    const jsDay = now.getDay();
    const currentDay = jsDay === 0 ? 6 : jsDay - 1; // Convert: Sun=6, Mon=0, Tue=1, etc.
    return [
        { startHour, startMinute: 0, endHour, endMinute: 0, days: [currentDay] }
    ];
}

// Switch between instant and schedule modes
function setScheduleMode(isSchedule) {
    isScheduleMode = isSchedule;

    // Update tab active states
    document.getElementById('instant-mode-tab').classList.toggle('active', !isSchedule);
    document.getElementById('schedule-mode-tab').classList.toggle('active', isSchedule);

    // Update section heading
    const heading = document.querySelector('#scheduler-section .section-header h2');
    if (heading) {
        heading.textContent = isSchedule ? 'Schedule a Block' : 'Start a Block';
    }

    // Toggle panels
    const instantPanel = document.getElementById('instant-block-panel');
    const schedulePanel = document.getElementById('schedule-block-panel');
    const startBlockBtn = document.getElementById('start-block-btn');
    const startScheduleBtn = document.getElementById('start-schedule-btn');

    if (isSchedule) {
        // Check if selected blocklist has an existing schedule
        const existingSchedule = selectedBlocklistId && appData.schedules
            ? appData.schedules.find(s => s.blocklistId === selectedBlocklistId)
            : null;

        if (existingSchedule && existingSchedule.segments) {
            // Load existing schedule segments (locked)
            scheduleSegments = existingSchedule.segments.map(seg => ({ ...seg }));
            activeScheduleSegmentCount = scheduleSegments.length;
            scheduleRepeatType = existingSchedule.repeatType || 'no';
            scheduleRepeatDate = existingSchedule.repeatDate;

            // Also load any pending (new) segments that were added but not yet committed
            const pendingSegments = appData.settings?.pendingScheduleSegments?.[selectedBlocklistId];
            if (pendingSegments && pendingSegments.length > 0) {
                // Append pending segments to the existing locked segments
                scheduleSegments.push(...pendingSegments.map(seg => ({ ...seg })));
            }
        } else {
            // Check for pending (unsaved) segments for this blocklist
            const pendingSegments = appData.settings?.pendingScheduleSegments?.[selectedBlocklistId];
            if (pendingSegments && pendingSegments.length > 0) {
                scheduleSegments = pendingSegments.map(seg => ({ ...seg }));
            } else {
                // Reset schedule segments to fresh default times
                scheduleSegments = getDefaultScheduleSegments();
            }
            activeScheduleSegmentCount = 0;
        }
        rebuildScheduleSegments();

        instantPanel.classList.add('hidden');
        schedulePanel.classList.remove('hidden');
        startBlockBtn.classList.add('hidden');
        if (selectedBlocklistId) {
            startScheduleBtn.classList.remove('hidden');
            updateScheduleButtonState();
        }
    } else {
        instantPanel.classList.remove('hidden');
        schedulePanel.classList.add('hidden');
        startScheduleBtn.classList.add('hidden');
        if (selectedBlocklistId) {
            startBlockBtn.classList.remove('hidden');
        }
    }

    // Toggle schedule-mode class on day-tracks for click-to-create
    document.querySelectorAll('.day-track').forEach(track => {
        track.classList.toggle('schedule-mode', isSchedule);
    });

    // Update calendar preview
    handleTimeChange();
}

// Toggle Repeat dropdown visibility
function toggleRepeatDropdown(e) {
    e.stopPropagation();

    // Don't allow opening dropdown when schedule is active
    if (activeScheduleSegmentCount > 0) return;

    // Also check if button is disabled
    const repeatDropdownBtn = document.getElementById('repeat-dropdown-btn');
    if (repeatDropdownBtn && repeatDropdownBtn.disabled) {
        return;
    }

    const menu = document.getElementById('repeat-dropdown-menu');
    if (!menu) return;

    const isHidden = menu.classList.contains('hidden');
    menu.classList.toggle('hidden');

    if (isHidden) {
        // Close on outside click
        setTimeout(() => {
            document.addEventListener('click', function closeMenu(evt) {
                if (!menu.contains(evt.target)) {
                    menu.classList.add('hidden');
                    document.removeEventListener('click', closeMenu);
                }
            });
        }, 10);
    }
}

// Handle Repeat option selection
function handleRepeatOptionClick(e) {
    // Don't allow changing repeat options when schedule is active
    if (activeScheduleSegmentCount > 0) {
        // Close dropdown silently
        const menu = document.getElementById('repeat-dropdown-menu');
        if (menu) menu.classList.add('hidden');
        return;
    }

    const value = e.target.dataset.value;
    const menu = document.getElementById('repeat-dropdown-menu');
    const btnText = document.getElementById('repeat-dropdown-text');
    const dateInput = document.getElementById('repeat-date-input');

    scheduleRepeatType = value;

    // Update dropdown text
    if (btnText) {
        if (value === 'no') {
            btnText.textContent = 'No';
        } else if (value === 'forever') {
            btnText.textContent = 'Forever';
        } else {
            btnText.textContent = 'Until date';
        }
    }

    // Update active state
    document.querySelectorAll('.repeat-option').forEach(opt => {
        opt.classList.toggle('active', opt.dataset.value === value);
    });

    // Show/hide date input wrapper
    const dateWrapper = document.getElementById('repeat-date-wrapper');
    const dateOverlay = document.getElementById('repeat-date-overlay');
    if (dateInput && dateWrapper) {
        if (value === 'date') {
            dateWrapper.classList.remove('hidden');
            // Set default date to 6 days from now (completing a full week including today)
            if (!scheduleRepeatDate) {
                const defaultDate = new Date();
                defaultDate.setDate(defaultDate.getDate() + 6);
                scheduleRepeatDate = defaultDate;
                dateInput.value = formatDateForInput(defaultDate);
            }
            // Update overlay with formatted date
            if (dateOverlay) {
                dateOverlay.textContent = formatDateForDisplay(scheduleRepeatDate);
            }
        } else {
            dateWrapper.classList.add('hidden');
            scheduleRepeatDate = null;
        }
    }

    // Close menu
    if (menu) menu.classList.add('hidden');

    // Update preview
    handleTimeChange();
}

// Handle Repeat date change
function handleRepeatDateChange(e) {
    const dateStr = e.target.value;
    if (dateStr) {
        scheduleRepeatDate = new Date(dateStr + 'T23:59:59');
        // Update the overlay with formatted date
        const dateOverlay = document.getElementById('repeat-date-overlay');
        if (dateOverlay) {
            dateOverlay.textContent = formatDateForDisplay(scheduleRepeatDate);
        }
        // Update preview
        handleTimeChange();
    }
}

// Format date for input element (YYYY-MM-DD)
function formatDateForInput(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

// Format date for display (e.g., "3 Feb 2026")
function formatDateForDisplay(date) {
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const day = date.getDate();
    const month = months[date.getMonth()];
    const year = date.getFullYear();
    return `${day} ${month} ${year}`;
}

// Update schedule button enabled state
function updateScheduleButtonState() {
    const startScheduleBtn = document.getElementById('start-schedule-btn');
    if (!startScheduleBtn) return;

    // Check if selected blocklist has an active schedule
    const activeSchedule = selectedBlocklistId && appData.schedules
        ? appData.schedules.find(s => s.blocklistId === selectedBlocklistId)
        : null;

    const blocklist = selectedBlocklistId
        ? appData.blocklists.find(bl => bl.id === selectedBlocklistId)
        : null;

    const btnLabel = startScheduleBtn.querySelector('.btn-label');
    const btnName = startScheduleBtn.querySelector('.btn-name');
    const btnIcon = startScheduleBtn.querySelector('svg');

    // Check if there are new segments (beyond the locked count)
    const hasNewSegments = activeSchedule && scheduleSegments.length > activeScheduleSegmentCount;

    if (activeSchedule && !hasNewSegments) {
        // Active schedule with no pending changes - show Stop button (grey/secondary style)
        if (btnLabel) btnLabel.textContent = 'Stop schedule:';
        if (btnName) btnName.textContent = blocklist ? blocklist.name : '';
        startScheduleBtn.classList.add('stop-schedule');
        startScheduleBtn.classList.remove('edit-schedule');
        startScheduleBtn.disabled = false;
        startScheduleBtn.dataset.activeScheduleId = activeSchedule.id || activeSchedule.blocklistId;

        // Change to unlock icon
        if (btnIcon) {
            btnIcon.innerHTML = `
                <rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect>
                <path d="M7 11V7a5 5 0 0 1 9.9-1"></path>
            `;
        }

        // Disable controls for existing segments
        disableScheduleControls(true);
    } else if (activeSchedule && hasNewSegments) {
        // Active schedule with pending new segments - show Edit button (dark/primary style)
        if (btnLabel) btnLabel.textContent = 'Edit schedule:';
        if (btnName) btnName.textContent = blocklist ? blocklist.name : '';
        startScheduleBtn.classList.remove('stop-schedule');
        startScheduleBtn.classList.add('edit-schedule');
        startScheduleBtn.disabled = false;
        startScheduleBtn.dataset.activeScheduleId = activeSchedule.id || activeSchedule.blocklistId;

        // Calendar icon for edit mode
        if (btnIcon) {
            btnIcon.innerHTML = `
                <rect x="3" y="4" width="18" height="18" rx="2" ry="2"></rect>
                <line x1="16" y1="2" x2="16" y2="6"></line>
                <line x1="8" y1="2" x2="8" y2="6"></line>
                <line x1="3" y1="10" x2="21" y2="10"></line>
            `;
        }

        // Controls are mixed - existing segments disabled, new segments enabled
        disableScheduleControls(true);
    } else {
        // No active schedule - show Start button (normal)
        if (btnLabel) btnLabel.textContent = 'Start schedule:';
        if (btnName) btnName.textContent = blocklist ? blocklist.name : '';
        startScheduleBtn.classList.remove('stop-schedule');
        startScheduleBtn.classList.remove('edit-schedule');
        delete startScheduleBtn.dataset.activeScheduleId;

        // Lock icon
        if (btnIcon) {
            btnIcon.innerHTML = `
                <rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect>
                <path d="M7 11V7a5 5 0 0 1 10 0v4"></path>
            `;
        }

        // Enable all controls
        disableScheduleControls(false);
    }

    // Enable button if blocklist is selected
    const isValid = selectedBlocklistId;
    startScheduleBtn.disabled = !isValid;
}

// Add a new time segment
function addScheduleSegment() {
    // Don't allow adding segments when schedule is active
    if (activeScheduleSegmentCount > 0) {
        return;
    }

    // Get the previous segment's end time, round up to next full hour for new start
    const prevSegment = scheduleSegments[scheduleSegments.length - 1];
    let newStartHour;
    if (prevSegment) {
        // Start 1 hour after previous end, round up if minutes present
        newStartHour = prevSegment.endMinute > 0
            ? (prevSegment.endHour + 2) % 24
            : (prevSegment.endHour + 1) % 24;
    } else {
        newStartHour = 14;
    }
    const newStartMinute = 0; // Always start on the hour
    // Default to 2 hours after start
    const newEndHour = (newStartHour + 2) % 24;
    const newEndMinute = 0;

    // Default to current day (0=Mon...6=Sun)
    const jsDay = new Date().getDay();
    const currentDay = jsDay === 0 ? 6 : jsDay - 1;

    // Add to state
    scheduleSegments.push({
        startHour: newStartHour,
        startMinute: newStartMinute,
        endHour: newEndHour,
        endMinute: newEndMinute,
        days: [currentDay]
    });

    // Rebuild all segments to ensure consistent rendering
    rebuildScheduleSegments();

    // Re-apply disabled state to locked segments (if schedule is active)
    if (activeScheduleSegmentCount > 0) {
        disableScheduleControls(true);
    }

    // Update calendar preview and button state
    handleTimeChange();
    updateScheduleButtonState();
}

// Handle clicking a day toggle within a segment
function handleSegmentDayToggle(segmentIndex, dayIndex, btn) {
    // Don't allow toggling days on locked segments (part of active schedule)
    if (segmentIndex < activeScheduleSegmentCount) return;

    const segment = scheduleSegments[segmentIndex];
    if (!segment) return;

    // Toggle the day in the segment's days array
    const dayIdx = segment.days.indexOf(dayIndex);
    if (dayIdx === -1) {
        segment.days.push(dayIndex);
        segment.days.sort((a, b) => a - b);
        btn.classList.add('active');
    } else {
        // Allow removing the day (segment with no days just won't apply)
        segment.days.splice(dayIdx, 1);
        btn.classList.remove('active');
    }

    // Update preview and button state
    handleTimeChange();
    updateScheduleButtonState();
}

// Remove a time segment
function removeScheduleSegment(index) {
    // Don't allow removing locked segments (part of active schedule)
    if (index < activeScheduleSegmentCount) return;

    if (scheduleSegments.length <= 1) return; // Always keep at least one

    // Remove from state
    scheduleSegments.splice(index, 1);

    // Rebuild DOM (simpler than updating indices)
    rebuildScheduleSegments();

    // Update calendar preview
    handleTimeChange();
}

// Sort schedule segments chronologically by start time
function sortScheduleSegments() {
    scheduleSegments.sort((a, b) => {
        // Compare by start hour first, then by start minute
        const aMinutes = a.startHour * 60 + a.startMinute;
        const bMinutes = b.startHour * 60 + b.startMinute;
        return aMinutes - bMinutes;
    });
}

// Rebuild schedule segments DOM from state
function rebuildScheduleSegments() {
    // Sort chronologically before rebuilding
    sortScheduleSegments();

    const container = document.getElementById('schedule-segments');
    container.innerHTML = '';

    const dayLabels = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];

    scheduleSegments.forEach((seg, index) => {
        const segment = document.createElement('div');
        segment.className = 'schedule-segment';
        segment.dataset.segmentIndex = index;

        const showRemove = scheduleSegments.length > 1;
        const segmentDays = seg.days || [];

        // Generate day toggles HTML
        const dayTogglesHtml = dayLabels.map((label, i) =>
            `<button type="button" class="segment-day-toggle${segmentDays.includes(i) ? ' active' : ''}" data-day="${i}">${label}</button>`
        ).join('');

        // Only show labels on the first segment
        const showLabels = index === 0;

        segment.innerHTML = `
            <div class="segment-row">
                <div class="time-pickers-row">
                    <div class="time-picker-group">
                        ${showLabels ? '<label class="time-label">Start</label>' : ''}
                        <div class="time-picker-row">
                            <div class="time-display schedule-start-display">
                                <div class="time-part-wrapper">
                                    <button class="time-part schedule-hour-btn" data-type="hour" data-target="schedule-start-${index}">${String(seg.startHour).padStart(2, '0')}</button>
                                </div>
                                <span class="time-colon">:</span>
                                <div class="time-part-wrapper">
                                    <button class="time-part schedule-minute-btn" data-type="minute" data-target="schedule-start-${index}">${String(seg.startMinute).padStart(2, '0')}</button>
                                </div>
                            </div>
                        </div>
                    </div>
                    <span class="time-separator">→</span>
                    <div class="time-picker-group">
                        ${showLabels ? '<label class="time-label">End</label>' : ''}
                        <div class="time-picker-row">
                            <div class="time-display schedule-end-display">
                                <div class="time-part-wrapper">
                                    <button class="time-part schedule-hour-btn" data-type="hour" data-target="schedule-end-${index}">${String(seg.endHour).padStart(2, '0')}</button>
                                </div>
                                <span class="time-colon">:</span>
                                <div class="time-part-wrapper">
                                    <button class="time-part schedule-minute-btn" data-type="minute" data-target="schedule-end-${index}">${String(seg.endMinute).padStart(2, '0')}</button>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
                <div class="segment-days-group">
                    ${showLabels ? '<label class="time-label">Days</label>' : ''}
                    <div class="segment-days" data-segment-index="${index}">
                        ${dayTogglesHtml}
                    </div>
                </div>
                ${showRemove ? `
                    <button type="button" class="remove-segment-btn" data-segment-index="${index}">
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                            stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                            <line x1="18" y1="6" x2="6" y2="18"></line>
                            <line x1="6" y1="6" x2="18" y2="18"></line>
                        </svg>
                    </button>
                ` : ''}
            </div>
        `;

        container.appendChild(segment);

        // Add click handlers for time parts
        segment.querySelectorAll('.time-part').forEach(btn => {
            btn.addEventListener('click', handleScheduleTimeClick);
        });

        // Add click handlers for day toggles
        segment.querySelectorAll('.segment-day-toggle').forEach(btn => {
            btn.addEventListener('click', () => {
                const dayIndex = parseInt(btn.dataset.day);
                handleSegmentDayToggle(index, dayIndex, btn);
            });
        });

        // Add click handler for remove button
        const removeBtn = segment.querySelector('.remove-segment-btn');
        if (removeBtn) {
            removeBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                const idx = parseInt(removeBtn.dataset.segmentIndex);
                removeScheduleSegment(idx);
            });
        }
    });
}

// Handle schedule time button click (show popover)
function handleScheduleTimeClick(e) {
    e.stopPropagation();
    const btn = e.target;
    const type = btn.dataset.type; // 'hour' or 'minute'
    const target = btn.dataset.target; // e.g., 'schedule-start-0' or 'schedule-end-1'

    // Parse target
    const parts = target.split('-');
    const isStart = parts[1] === 'start';
    const segmentIndex = parseInt(parts[2]);

    // Create and show popover for time selection
    showScheduleTimePopover(btn, type, isStart, segmentIndex);
}

// Show time popover for schedule time selection
function showScheduleTimePopover(btn, type, isStart, segmentIndex) {
    // Remove any existing schedule popovers
    document.querySelectorAll('.schedule-time-popover').forEach(p => p.remove());

    const popover = document.createElement('div');
    popover.className = 'time-popover schedule-time-popover';

    const scroll = document.createElement('div');
    scroll.className = 'popover-scroll';

    const segment = scheduleSegments[segmentIndex];
    const currentValue = type === 'hour'
        ? (isStart ? segment.startHour : segment.endHour)
        : (isStart ? segment.startMinute : segment.endMinute);

    const max = type === 'hour' ? 24 : 60;
    const step = type === 'hour' ? 1 : 5;

    for (let i = 0; i < max; i += step) {
        const option = document.createElement('button');
        option.className = 'popover-option' + (i === currentValue ? ' selected' : '');
        option.textContent = String(i).padStart(2, '0');
        option.addEventListener('click', (e) => {
            e.stopPropagation(); // Prevent blocklist deselection

            // Update state
            if (type === 'hour') {
                if (isStart) segment.startHour = i;
                else segment.endHour = i;
            } else {
                if (isStart) segment.startMinute = i;
                else segment.endMinute = i;
            }

            // Update button text
            btn.textContent = String(i).padStart(2, '0');

            // Close popover
            popover.remove();

            // Update calendar preview
            handleTimeChange();
        });
        scroll.appendChild(option);
    }

    popover.appendChild(scroll);
    btn.parentElement.appendChild(popover);

    // Scroll to current value
    const activeOption = scroll.querySelector('.selected');
    if (activeOption) {
        activeOption.scrollIntoView({ block: 'center' });
    }

    // Close on outside click
    setTimeout(() => {
        document.addEventListener('click', function closePopover(e) {
            if (!popover.contains(e.target) && e.target !== btn) {
                popover.remove();
                document.removeEventListener('click', closePopover);
            }
        });
    }, 10);
}

// Start a schedule - show confirmation modal first
async function startSchedule() {
    if (!selectedBlocklistId) return;

    const blocklist = appData.blocklists.find(bl => bl.id === selectedBlocklistId);
    if (!blocklist) return;

    // Check if this blocklist already has an active schedule
    const activeSchedule = appData.schedules
        ? appData.schedules.find(s => s.blocklistId === selectedBlocklistId)
        : null;

    // Check if there are new segments beyond the locked count
    const hasNewSegments = activeSchedule && scheduleSegments.length > activeScheduleSegmentCount;

    if (activeSchedule && !hasNewSegments) {
        // Stop mode - open override dialog for the schedule
        openScheduleOverrideModal(activeSchedule);
        return;
    }

    if (activeSchedule && hasNewSegments) {
        // Edit mode - show confirmation for adding new segments only
        const newSegments = scheduleSegments.slice(activeScheduleSegmentCount);
        showScheduleEditConfirmModal(blocklist, activeSchedule, newSegments);
        return;
    }

    // Normal start mode - check that at least one segment has days
    const hasAnyDays = scheduleSegments.some(seg => seg.days && seg.days.length > 0);
    if (!hasAnyDays) return;

    // Show confirmation modal for new schedule
    showScheduleConfirmModal(blocklist);
}

// Show schedule confirmation modal
function showScheduleConfirmModal(blocklist) {
    const dayNames = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

    // Blocklist name
    document.getElementById('schedule-confirm-name').textContent = blocklist.name;

    // Websites
    const websites = blocklist.websites || [];
    const websitesRow = document.getElementById('schedule-websites-row');
    const websitesEl = document.getElementById('schedule-confirm-websites');
    const showAllWebsitesBtn = document.getElementById('show-all-schedule-websites');

    if (websites.length === 0) {
        websitesRow.classList.add('hidden');
    } else {
        websitesRow.classList.remove('hidden');
        const maxShow = 3;
        if (websites.length <= maxShow) {
            websitesEl.textContent = websites.join(', ');
            showAllWebsitesBtn.classList.add('hidden');
        } else {
            websitesEl.textContent = websites.slice(0, maxShow).join(', ') + '...';
            websitesEl.dataset.fullList = websites.join(', ');
            showAllWebsitesBtn.classList.remove('hidden');
            showAllWebsitesBtn.onclick = () => {
                websitesEl.textContent = websites.join(', ');
                showAllWebsitesBtn.classList.add('hidden');
            };
        }
    }

    // Apps
    const apps = blocklist.apps || [];
    const appsRow = document.getElementById('schedule-apps-row');
    const appsEl = document.getElementById('schedule-confirm-apps');
    const showAllAppsBtn = document.getElementById('show-all-schedule-apps');

    if (apps.length === 0) {
        appsRow.classList.add('hidden');
    } else {
        appsRow.classList.remove('hidden');
        const maxShow = 3;
        if (apps.length <= maxShow) {
            appsEl.textContent = apps.join(', ');
            showAllAppsBtn.classList.add('hidden');
        } else {
            appsEl.textContent = apps.slice(0, maxShow).join(', ') + '...';
            showAllAppsBtn.classList.remove('hidden');
            showAllAppsBtn.onclick = () => {
                appsEl.textContent = apps.join(', ');
                showAllAppsBtn.classList.add('hidden');
            };
        }
    }

    // Schedule segments
    const segmentsEl = document.getElementById('schedule-confirm-segments');
    segmentsEl.innerHTML = '';

    scheduleSegments.forEach((seg, index) => {
        const segDays = (seg.days || []).map(d => dayNames[d]).join(', ');
        const startTime = `${String(seg.startHour).padStart(2, '0')}:${String(seg.startMinute).padStart(2, '0')}`;
        const endTime = `${String(seg.endHour).padStart(2, '0')}:${String(seg.endMinute).padStart(2, '0')}`;

        const row = document.createElement('div');
        row.className = 'schedule-segment-row';
        row.innerHTML = `
            <span class="segment-time">${startTime} → ${endTime}</span>
            <span class="segment-days">${segDays || 'No days selected'}</span>
        `;
        segmentsEl.appendChild(row);
    });

    // Repeat info
    const repeatEl = document.getElementById('schedule-confirm-repeat');
    if (scheduleRepeatType === 'forever') {
        repeatEl.textContent = 'Forever';
    } else if (scheduleRepeatType === 'date' && scheduleRepeatDate) {
        repeatEl.textContent = `Until ${scheduleRepeatDate.toLocaleDateString()}`;
    } else {
        repeatEl.textContent = 'No';
    }

    // Override info
    const charCount = blocklist.overrideCharCount || 60;
    const charsPerMinute = 30;
    const estimatedMinutes = Math.ceil(charCount / charsPerMinute);
    const charWord = charCount === 1 ? 'character' : 'characters';

    let overrideText;
    if (blocklist.overrideType === 'random') {
        overrideText = `Type ${charCount} random ${charWord} (letters and numbers) exactly as shown (~${estimatedMinutes} min).`;
    } else {
        overrideText = `Type ${charCount} ${charWord} (displayed as random words) exactly as shown (~${estimatedMinutes} min).`;
    }

    document.getElementById('schedule-confirm-override-text').textContent = overrideText;

    // Show modal
    document.getElementById('start-schedule-confirm-modal').classList.remove('hidden');
}

// Close schedule confirmation modal
function closeScheduleConfirmModal() {
    document.getElementById('start-schedule-confirm-modal').classList.add('hidden');
}

// Open override modal for stopping a schedule (uses same override modal as blocks)
// This is ONLY called from the stop schedule button - always stops entire schedule
function openScheduleOverrideModal(schedule) {
    // Store the schedule ID for the override process
    window.overrideScheduleId = schedule.id || schedule.blocklistId;

    // Clear segment index/day - this ensures we can ONLY stop the entire schedule
    window.overrideSegmentIndex = undefined;
    window.overrideSegmentDay = undefined;

    // Get the blocklist name
    const blocklist = appData.blocklists.find(bl => bl.id === schedule.blocklistId);
    const blocklistName = blocklist ? blocklist.name : 'Schedule';

    // Set the challenge text for the override modal using blocklist settings
    const difficulty = blocklist?.overrideDifficulty || { type: 'random-words', count: 50 };
    const charCount = difficulty.count || 50;
    const isRandom = difficulty.type === 'gibberish';

    // Use the existing override modal - set up challenge
    challengeText = isRandom ? generateGibberish(charCount) : generateRandomWords(charCount);
    overrideBlockId = null; // Not a block, it's a schedule

    // Update modal title to indicate it's a schedule
    const titleEl = document.getElementById('override-modal-title');
    if (titleEl) {
        titleEl.textContent = `Stop Schedule: ${blocklistName}`;
    }

    // Hide the radio options - stop schedule button ONLY stops entire schedule
    const optionsDiv = document.getElementById('schedule-override-options');
    if (optionsDiv) {
        optionsDiv.classList.add('hidden');
    }

    // Set override type to stop-schedule (even though options are hidden)
    const stopScheduleRadio = document.querySelector('input[name="schedule-override-type"][value="stop-schedule"]');
    if (stopScheduleRadio) {
        stopScheduleRadio.checked = true;
    }

    // Render challenge text directly (renderChallengeText is scoped inside setupOverrideModalListeners)
    const challengeTextEl = document.getElementById('challenge-text');
    if (challengeTextEl) {
        challengeTextEl.textContent = challengeText;
    }

    // Clear input and progress
    const challengeInput = document.getElementById('challenge-input');
    if (challengeInput) challengeInput.value = '';
    const progressBar = document.getElementById('challenge-progress-bar');
    if (progressBar) progressBar.style.width = '0%';

    document.getElementById('override-modal').classList.remove('hidden');
}

// Open schedule override modal when clicking on a scheduled block in the calendar
function openScheduledBlockOverrideModal(schedule, segmentIndex, day) {
    // Store the schedule info for the override process
    window.overrideScheduleId = schedule.id;
    window.overrideSegmentIndex = segmentIndex;
    window.overrideSegmentDay = day;

    // Get the blocklist
    const blocklist = appData.blocklists.find(bl => bl.id === schedule.blocklistId);
    const blocklistName = blocklist ? blocklist.name : 'Schedule';

    // Calculate if this schedule has multiple occurrences
    const segment = schedule.segments[segmentIndex];
    const totalDaysInSegment = segment ? segment.days.length : 1;
    const totalSegments = schedule.segments.length;
    const hasMultipleOccurrences = totalSegments > 1 || totalDaysInSegment > 1 ||
        (schedule.repeatType === 'forever' || schedule.repeatType === 'date');

    // Show/hide the radio options based on multiple occurrences
    const optionsDiv = document.getElementById('schedule-override-options');
    if (hasMultipleOccurrences) {
        optionsDiv.classList.remove('hidden');
        // Reset to default "Just this block"
        document.querySelector('input[name="schedule-override-type"][value="just-this"]').checked = true;
    } else {
        optionsDiv.classList.add('hidden');
    }

    // Set up the challenge text using blocklist settings
    const difficulty = blocklist?.overrideDifficulty || { type: 'random-words', count: 50 };
    const charCount = difficulty.count || 50;
    const isRandom = difficulty.type === 'gibberish';
    challengeText = isRandom ? generateGibberish(charCount) : generateRandomWords(charCount);
    overrideBlockId = null; // Not a one-off block

    // Update modal title
    const titleEl = document.getElementById('override-modal-title');
    if (titleEl) {
        titleEl.textContent = `Override Scheduled Block?`;
    }

    // Update summary
    const summaryEl = document.getElementById('override-summary');
    if (summaryEl && blocklist) {
        summaryEl.innerHTML = `<span class="block-name">${blocklist.emoji || ''} ${blocklistName}</span>`;
    }

    // Render challenge text
    const challengeTextEl = document.getElementById('challenge-text');
    if (challengeTextEl) {
        challengeTextEl.textContent = challengeText;
    }

    // Clear input and progress
    const challengeInput = document.getElementById('challenge-input');
    if (challengeInput) challengeInput.value = '';
    const progressBar = document.getElementById('challenge-progress-bar');
    if (progressBar) progressBar.style.width = '0%';

    document.getElementById('override-modal').classList.remove('hidden');
}

// Show confirmation modal for editing (adding segments to) an existing schedule
function showScheduleEditConfirmModal(blocklist, existingSchedule, newSegments) {
    const dayNames = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

    // Store references for the proceed function
    window.editScheduleData = {
        scheduleId: existingSchedule.id || existingSchedule.blocklistId,
        newSegments: newSegments
    };

    // Blocklist name
    document.getElementById('schedule-confirm-name').textContent = `Add to: ${blocklist.name}`;

    // Hide websites and apps rows (not changing those)
    document.getElementById('schedule-websites-row').classList.add('hidden');
    document.getElementById('schedule-apps-row').classList.add('hidden');

    // Show NEW segments only
    const segmentsEl = document.getElementById('schedule-confirm-segments');
    segmentsEl.innerHTML = '<div class="edit-schedule-notice">Adding these time segments:</div>';

    newSegments.forEach((seg, index) => {
        const segDays = (seg.days || []).map(d => dayNames[d]).join(', ');
        const startTime = `${String(seg.startHour).padStart(2, '0')}:${String(seg.startMinute).padStart(2, '0')}`;
        const endTime = `${String(seg.endHour).padStart(2, '0')}:${String(seg.endMinute).padStart(2, '0')}`;

        const row = document.createElement('div');
        row.className = 'schedule-segment-row new-segment';
        row.innerHTML = `
            <span class="segment-time">${startTime} → ${endTime}</span>
            <span class="segment-days">${segDays || 'No days selected'}</span>
        `;
        segmentsEl.appendChild(row);
    });

    // Hide repeat info (not changing)
    document.getElementById('schedule-confirm-repeat').parentElement.classList.add('hidden');

    // Update modal button to say "Add Segments"
    const confirmBtn = document.querySelector('#start-schedule-confirm-modal .confirm-btn');
    if (confirmBtn) {
        confirmBtn.textContent = 'Add Segments';
        confirmBtn.onclick = proceedWithScheduleEdit;
    }

    // Show modal
    document.getElementById('start-schedule-confirm-modal').classList.remove('hidden');
}

// Add new segments to existing schedule
async function proceedWithScheduleEdit() {
    closeScheduleConfirmModal();

    const editData = window.editScheduleData;
    if (!editData) return;

    // Find the existing schedule
    const schedule = appData.schedules.find(s =>
        s.id === editData.scheduleId || s.blocklistId === editData.scheduleId
    );
    if (!schedule) return;

    // Add the new segments
    editData.newSegments.forEach(seg => {
        schedule.segments.push({
            startHour: seg.startHour,
            startMinute: seg.startMinute,
            endHour: seg.endHour,
            endMinute: seg.endMinute,
            days: [...seg.days]
        });
    });

    // Update activeScheduleSegmentCount to include the new segments
    activeScheduleSegmentCount = schedule.segments.length;
    scheduleSegments = schedule.segments.map(seg => ({ ...seg }));

    // Clear pending segments for this blocklist (they're now committed)
    if (appData.settings?.pendingScheduleSegments?.[selectedBlocklistId]) {
        delete appData.settings.pendingScheduleSegments[selectedBlocklistId];
    }

    // Save
    await saveData();

    console.log('Schedule updated with new segments:', schedule);

    // Restore the confirm button to normal
    const confirmBtn = document.querySelector('#start-schedule-confirm-modal .confirm-btn');
    if (confirmBtn) {
        confirmBtn.textContent = 'Start Schedule';
        confirmBtn.onclick = proceedWithSchedule;
    }

    // Restore hidden rows
    document.getElementById('schedule-confirm-repeat').parentElement.classList.remove('hidden');

    // Update UI
    updateScheduleButtonState();
    renderBlocklists();
    updateWeekCalendar();

    // Clean up
    delete window.editScheduleData;
}

// Actually create the schedule (called after confirmation)
async function proceedWithSchedule() {
    closeScheduleConfirmModal();

    const blocklist = appData.blocklists.find(bl => bl.id === selectedBlocklistId);
    if (!blocklist) return;

    // Create schedule object
    const schedule = {
        id: crypto.randomUUID(),
        blocklistId: selectedBlocklistId,
        segments: scheduleSegments.map(seg => ({
            startHour: seg.startHour,
            startMinute: seg.startMinute,
            endHour: seg.endHour,
            endMinute: seg.endMinute,
            days: [...seg.days]
        })),
        repeatType: scheduleRepeatType,
        repeatDate: scheduleRepeatType === 'date' ? scheduleRepeatDate : null,
        createdAt: Date.now()
    };

    // Save to appData
    appData.schedules.push(schedule);

    // Clear pending segments for this blocklist (they're now committed)
    if (appData.settings?.pendingScheduleSegments?.[selectedBlocklistId]) {
        delete appData.settings.pendingScheduleSegments[selectedBlocklistId];
    }

    await saveData();

    console.log('Schedule created:', schedule);

    // Update blocked apps if schedule is currently active
    await updateBlockedApps();

    // Update the active segment count to lock the created segments
    activeScheduleSegmentCount = scheduleSegments.length;

    // Reset schedule repeat options for next use
    scheduleRepeatType = 'forever';
    scheduleRepeatDate = null;

    // Rebuild segments UI to show them as locked
    rebuildScheduleSegments();
    disableScheduleControls(true);
    updateScheduleButtonState();

    // Re-render blocklists to show schedule badge
    renderBlocklists();

    // Update calendar to show scheduled blocks
    updateWeekCalendar();

    // Clear preview blocks
    document.querySelectorAll('.calendar-block.preview').forEach(el => el.remove());

    // Trigger hosts file update to start blocking if schedule is currently active
    await updateHostsFile();
}
// Handle time picker change
function handleTimeChange() {
    const noBlocksMsg = document.getElementById('no-blocks-message');
    const startBtn = document.getElementById('start-block-btn');
    const nextDayIndicator = document.getElementById('next-day-indicator');

    // Remove any existing preview blocks and active-schedule blocks (for schedule mode)
    document.querySelectorAll('.calendar-block.preview, .calendar-block.active-schedule').forEach(el => el.remove());

    // Handle schedule mode separately
    if (isScheduleMode) {
        renderSchedulePreview();

        // Save pending schedule segments for this blocklist
        if (selectedBlocklistId) {
            if (!appData.settings) appData.settings = {};
            if (!appData.settings.pendingScheduleSegments) appData.settings.pendingScheduleSegments = {};

            const existingSchedule = appData.schedules?.find(s => s.blocklistId === selectedBlocklistId);

            if (!existingSchedule) {
                // No active schedule - save all pending segments
                const currentPending = JSON.stringify(appData.settings.pendingScheduleSegments[selectedBlocklistId] || []);
                const newPending = JSON.stringify(scheduleSegments);
                if (currentPending !== newPending) {
                    appData.settings.pendingScheduleSegments[selectedBlocklistId] = scheduleSegments.map(seg => ({ ...seg }));
                    saveData();
                }
            } else {
                // Active schedule exists - save only NEW segments (those beyond activeScheduleSegmentCount)
                if (scheduleSegments.length > activeScheduleSegmentCount) {
                    const newSegments = scheduleSegments.slice(activeScheduleSegmentCount);
                    const currentPending = JSON.stringify(appData.settings.pendingScheduleSegments[selectedBlocklistId] || []);
                    const newPending = JSON.stringify(newSegments);
                    if (currentPending !== newPending) {
                        appData.settings.pendingScheduleSegments[selectedBlocklistId] = newSegments.map(seg => ({ ...seg }));
                        saveData();
                    }
                } else {
                    // No new segments - clear any pending segments
                    if (appData.settings.pendingScheduleSegments[selectedBlocklistId]) {
                        delete appData.settings.pendingScheduleSegments[selectedBlocklistId];
                        saveData();
                    }
                }
            }
        }
        return;
    }

    // --- Instant mode logic ---
    // Get times (start is always now)
    let blockStart = getStartTimeAsDate();
    let blockEnd = getEndTimeAsDate();

    // Determine block end time
    if (!userEditedEndTime && targetDurationMinutes > 0) {
        // If driving by duration, exact calculation
        blockEnd = new Date(blockStart.getTime() + targetDurationMinutes * 60 * 1000);
    } else {
        // If driving by end time picker, assume nearest future time (handle overnight)
        if (blockEnd <= blockStart) {
            blockEnd.setDate(blockEnd.getDate() + 1);
        }
    }

    // Calculate how many days in the future the end time is
    const startDay = new Date(blockStart);
    startDay.setHours(0, 0, 0, 0);
    const endDay = new Date(blockEnd);
    endDay.setHours(0, 0, 0, 0);
    const daysDiff = Math.round((endDay - startDay) / (24 * 60 * 60 * 1000));

    // Show/hide day indicator with correct count
    if (nextDayIndicator) {
        if (daysDiff > 0) {
            if (daysDiff === 1) {
                nextDayIndicator.textContent = 'tomorrow';
            } else {
                // For >1 days, show date like "8 Jan"
                const dateStr = blockEnd.getDate() + ' ' + blockEnd.toLocaleString('default', { month: 'short' });
                nextDayIndicator.textContent = dateStr;
            }
            nextDayIndicator.classList.remove('hidden');
        } else {
            nextDayIndicator.classList.add('hidden');
        }
    }

    // Calculate duration
    const durationMs = blockEnd.getTime() - blockStart.getTime();
    const durationMinutes = Math.round(durationMs / 60000);

    if (durationMinutes <= 0) {
        startBtn.disabled = true;
        return;
    }

    // Sync duration input and quick buttons with calculated duration
    const durationInput = document.getElementById('duration-minutes-input');
    if (durationInput && document.activeElement !== durationInput) {
        durationInput.value = durationMinutes;
    }
    updateDurationQuickBtns(durationMinutes);

    // Save duration to settings per-blocklist so it persists across blocklist selections
    if (selectedBlocklistId) {
        if (!appData.settings) appData.settings = {};
        if (!appData.settings.instantBlockDuration) appData.settings.instantBlockDuration = {};
        if (appData.settings.instantBlockDuration[selectedBlocklistId] !== durationMinutes) {
            appData.settings.instantBlockDuration[selectedBlocklistId] = durationMinutes;
            saveData();
        }
    }

    startBtn.disabled = !selectedBlocklistId;
    if (noBlocksMsg) {
        noBlocksMsg.classList.add('hidden');
    }

    // Create preview block in week calendar (only if no active block for this blocklist)
    const blocklist = appData.blocklists.find(bl => bl.id === selectedBlocklistId);
    const now = Date.now();
    const hasActiveBlock = blocklist && appData.activeBlocks.some(b => b.blocklistId === selectedBlocklistId && b.startTime <= now && b.endTime > now);

    if (blocklist && currentWeekStart && !hasActiveBlock) {
        renderPreviewBlock(blockStart, blockEnd, blocklist);
    }

    updateWindowHeight();
}

// Render schedule preview blocks on the calendar
function renderSchedulePreview() {
    if (!selectedBlocklistId || !currentWeekStart) return;

    const blocklist = appData.blocklists.find(bl => bl.id === selectedBlocklistId);
    if (!blocklist) return;

    // Determine the visible date range (21 days: 7 before anchor to 7 after anchor + 7)
    const renderStart = new Date(currentWeekStart);
    renderStart.setDate(renderStart.getDate() - 7);

    // For each segment, render blocks on its specific days
    scheduleSegments.forEach((segment, segmentIndex) => {
        // Determine if this is a locked (active) segment or a new preview segment
        const isLockedSegment = segmentIndex < activeScheduleSegmentCount;

        // Get the days for this segment (0=Mon, 1=Tue, ..., 6=Sun)
        const segmentDays = segment.days || [];

        // For non-repeating schedules, only render on the anchor week
        // For repeating schedules (forever or date), render on all visible weeks
        const shouldRepeat = scheduleRepeatType === 'forever' || scheduleRepeatType === 'date';
        const daysToRender = shouldRepeat ? 21 : 7;
        const dayOffset = shouldRepeat ? 0 : 7; // Non-repeating starts at anchor week (offset 7)

        for (let d = 0; d < daysToRender; d++) {
            const dayDate = new Date(renderStart);
            dayDate.setDate(dayDate.getDate() + d + dayOffset);

            // Convert JS day (0=Sun) to our format (0=Mon)
            const jsDayOfWeek = dayDate.getDay();
            const dayIndex = jsDayOfWeek === 0 ? 6 : jsDayOfWeek - 1;

            // Check if this day matches any selected days in the segment
            if (!segmentDays.includes(dayIndex)) continue;

            // For date-limited schedules, check if outside the "until" date
            if (scheduleRepeatType === 'date' && scheduleRepeatDate && dayDate > scheduleRepeatDate) {
                continue;
            }

            const blockStart = new Date(dayDate);
            blockStart.setHours(segment.startHour, segment.startMinute, 0, 0);

            const blockEnd = new Date(dayDate);
            blockEnd.setHours(segment.endHour, segment.endMinute, 0, 0);

            // Handle overnight blocks
            if (blockEnd <= blockStart) {
                blockEnd.setDate(blockEnd.getDate() + 1);
            }

            // Render as active block if locked, otherwise as preview
            if (isLockedSegment) {
                renderActiveScheduleBlock(blockStart, blockEnd, blocklist, segmentIndex);
            } else {
                renderPreviewBlock(blockStart, blockEnd, blocklist, true, segmentIndex);
            }
        }
    });
}

// Render an active (locked) schedule block on the calendar (not a preview)
function renderActiveScheduleBlock(blockStart, blockEnd, blocklist, segmentIndex) {
    const startDay = new Date(blockStart);
    startDay.setHours(0, 0, 0, 0);

    const endDay = new Date(blockEnd);
    endDay.setHours(0, 0, 0, 0);

    let currentDay = new Date(startDay);

    while (currentDay <= endDay) {
        const dateStr = currentDay.toISOString().split('T')[0];
        const track = document.querySelector(`.day-track[data-date="${dateStr}"]`);

        if (track) {
            const dayStart = new Date(currentDay);
            dayStart.setHours(0, 0, 0, 0);
            const dayEnd = new Date(currentDay);
            dayEnd.setHours(23, 59, 59, 999);

            const segmentStart = Math.max(blockStart.getTime(), dayStart.getTime());
            const segmentEnd = Math.min(blockEnd.getTime(), dayEnd.getTime());

            const startMinutes = new Date(segmentStart).getHours() * 60 + new Date(segmentStart).getMinutes();
            const endMinutes = new Date(segmentEnd).getHours() * 60 + new Date(segmentEnd).getMinutes();

            const topPosition = (startMinutes / 60) * 40;
            const height = Math.max(20, ((endMinutes - startMinutes) / 60) * 40);

            const startTimeStr = formatTime(new Date(segmentStart));
            const endTimeStr = formatTime(new Date(segmentEnd));

            const blockEl = document.createElement('div');
            blockEl.className = 'calendar-block active-schedule';
            blockEl.dataset.segmentIndex = segmentIndex;
            blockEl.style.top = `${topPosition}px`;
            blockEl.style.height = `${height}px`;

            if (blocklist.color) {
                blockEl.style.background = blocklist.color;
                blockEl.style.color = getContrastTextColor(blocklist.color);
            }

            blockEl.innerHTML = `
                <span class="block-emoji">${blocklist.emoji || '🚫'}</span>
                <span class="block-label">${escapeHtml(blocklist.name)}</span>
                <span class="block-time">${startTimeStr} - ${endTimeStr}</span>
                <span class="schedule-icon"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="18" x="3" y="4" rx="2" ry="2"/><path d="M16 2v4"/><path d="M8 2v4"/><path d="M3 10h18"/></svg></span>
            `;

            track.appendChild(blockEl);
        }

        currentDay.setDate(currentDay.getDate() + 1);
    }
}

// Render preview block on week calendar
function renderPreviewBlock(blockStart, blockEnd, blocklist, skipClear = false, segmentIndex = null) {
    // Clear any existing preview blocks first (unless rendering multiple schedule blocks)
    if (!skipClear) {
        document.querySelectorAll('.calendar-block.preview').forEach(el => el.remove());
    }

    const startDay = new Date(blockStart);
    startDay.setHours(0, 0, 0, 0);

    const endDay = new Date(blockEnd);
    endDay.setHours(0, 0, 0, 0);

    // Render preview in each day it spans
    let currentDay = new Date(startDay);

    while (currentDay <= endDay) {
        const dateStr = currentDay.toISOString().split('T')[0];
        const track = document.querySelector(`.day-track[data-date="${dateStr}"]`);

        if (track) {
            // Calculate start time for this day segment
            const dayStart = new Date(currentDay);
            dayStart.setHours(0, 0, 0, 0);
            const dayEnd = new Date(currentDay);
            dayEnd.setHours(23, 59, 59, 999);

            const segmentStart = Math.max(blockStart.getTime(), dayStart.getTime());
            const segmentEnd = Math.min(blockEnd.getTime(), dayEnd.getTime());

            const startMinutes = new Date(segmentStart).getHours() * 60 + new Date(segmentStart).getMinutes();
            const endMinutes = new Date(segmentEnd).getHours() * 60 + new Date(segmentEnd).getMinutes();

            // Calculate position (40px per hour)
            const topPosition = (startMinutes / 60) * 40;
            const height = Math.max(20, ((endMinutes - startMinutes) / 60) * 40);

            const previewEl = document.createElement('div');
            previewEl.className = 'calendar-block preview';
            previewEl.style.top = `${topPosition}px`;
            previewEl.style.height = `${height}px`;

            if (segmentIndex !== null) {
                previewEl.dataset.segmentIndex = segmentIndex;
                previewEl.classList.add('interactive');
            }

            if (blocklist.color) {
                previewEl.style.background = blocklist.color;
                previewEl.style.color = getContrastTextColor(blocklist.color);
            }

            // Add resize handles for schedule mode
            const resizeHandles = segmentIndex !== null ? `
                <div class="resize-handle resize-handle-top" data-handle="top" style="cursor: ns-resize;"></div>
                <div class="resize-handle resize-handle-bottom" data-handle="bottom" style="cursor: ns-resize;"></div>
            ` : '';

            previewEl.innerHTML = `
                ${resizeHandles}
                <span class="block-emoji">${blocklist.emoji || '🚫'}</span>
                <span class="block-label">${escapeHtml(blocklist.name)}</span>
                <span class="block-time">${formatTime(new Date(segmentStart))} - ${formatTime(new Date(segmentEnd))}</span>
            `;

            // Attach drag/resize event handlers for schedule mode
            if (segmentIndex !== null && isScheduleMode) {
                attachPreviewBlockDragHandlers(previewEl, segmentIndex, track);
            }

            track.appendChild(previewEl);
        }

        // Move to next day
        currentDay.setDate(currentDay.getDate() + 1);
    }
}

// Attach drag and resize handlers to a preview block
function attachPreviewBlockDragHandlers(previewEl, segmentIndex, track) {
    let isDragging = false;
    let isResizing = false;
    let resizeHandle = null;
    let startY = 0;
    let startX = 0;
    let startTop = 0;
    let startHeight = 0;
    let startDayIndex = null;
    let currentHoverTrack = track;
    let clickOffsetX = 0; // Offset from track center where user clicked
    const pixelsPerHour = 40;
    const snapMinutes = 15; // Snap to 15-minute intervals

    // Get the day index from the track's date
    function getDayIndexFromTrack(trackEl) {
        const dateStr = trackEl.dataset.date;
        if (!dateStr) return null;
        const date = new Date(dateStr);
        // Convert JS day (0=Sun) to our format (0=Mon)
        const jsDay = date.getDay();
        return jsDay === 0 ? 6 : jsDay - 1;
    }

    // Get the original day this block represents
    startDayIndex = getDayIndexFromTrack(track);

    // Convert pixels to minutes
    function pixelsToMinutes(px) {
        return (px / pixelsPerHour) * 60;
    }

    // Snap minutes to nearest interval
    function snapToInterval(minutes) {
        return Math.round(minutes / snapMinutes) * snapMinutes;
    }

    // Convert minutes to hours/minutes object
    function minutesToTime(totalMinutes) {
        totalMinutes = Math.max(0, Math.min(1440, totalMinutes)); // Clamp to 0-24 hours
        const hours = Math.floor(totalMinutes / 60);
        const minutes = totalMinutes % 60;
        return { hours: Math.min(23, hours), minutes };
    }

    // Update segment times and optionally days, then refresh UI
    function updateSegmentTimesAndDays(newStartMinutes, newEndMinutes, dayShift = 0) {
        const startTime = minutesToTime(newStartMinutes);
        const endTime = minutesToTime(newEndMinutes);

        // Ensure minimum duration of 15 minutes
        if (newEndMinutes - newStartMinutes < 15) {
            return;
        }

        scheduleSegments[segmentIndex].startHour = startTime.hours;
        scheduleSegments[segmentIndex].startMinute = startTime.minutes;
        scheduleSegments[segmentIndex].endHour = endTime.hours;
        scheduleSegments[segmentIndex].endMinute = endTime.minutes;

        // If there's a day shift, update the days array
        if (dayShift !== 0) {
            const segment = scheduleSegments[segmentIndex];
            const oldDays = segment.days || [];
            const newDays = oldDays.map(d => {
                let newDay = d + dayShift;
                // Wrap around the week (0-6)
                if (newDay < 0) newDay += 7;
                if (newDay > 6) newDay -= 7;
                return newDay;
            });
            segment.days = newDays;

            // Update the day toggle buttons in the UI
            updateDayToggleUI(segmentIndex);
        }

        // Update the time picker UI
        updateTimePickerUI(segmentIndex);

        // Re-render preview blocks
        document.querySelectorAll('.calendar-block.preview').forEach(el => el.remove());
        renderSchedulePreview();
    }

    // Update time picker buttons to reflect new times
    function updateTimePickerUI(index) {
        const segment = scheduleSegments[index];
        const startHourBtn = document.querySelector(`[data-target="schedule-start-${index}"][data-type="hour"]`);
        const startMinBtn = document.querySelector(`[data-target="schedule-start-${index}"][data-type="minute"]`);
        const endHourBtn = document.querySelector(`[data-target="schedule-end-${index}"][data-type="hour"]`);
        const endMinBtn = document.querySelector(`[data-target="schedule-end-${index}"][data-type="minute"]`);

        if (startHourBtn) startHourBtn.textContent = String(segment.startHour).padStart(2, '0');
        if (startMinBtn) startMinBtn.textContent = String(segment.startMinute).padStart(2, '0');
        if (endHourBtn) endHourBtn.textContent = String(segment.endHour).padStart(2, '0');
        if (endMinBtn) endMinBtn.textContent = String(segment.endMinute).padStart(2, '0');
    }

    // Update day toggle buttons in the schedule segment UI
    function updateDayToggleUI(index) {
        const segment = scheduleSegments[index];
        const days = segment.days || [];
        const segmentContainer = document.querySelector(`.schedule-segment[data-segment-index="${index}"]`);
        if (!segmentContainer) return;

        const dayButtons = segmentContainer.querySelectorAll('.segment-day-toggle');
        dayButtons.forEach(btn => {
            const dayIndex = parseInt(btn.dataset.day);
            if (days.includes(dayIndex)) {
                btn.classList.add('active');
            } else {
                btn.classList.remove('active');
            }
        });
    }

    // Add hover listeners to resize handles to change cursor
    const resizeHandles = previewEl.querySelectorAll('.resize-handle');
    resizeHandles.forEach(handle => {
        handle.addEventListener('mouseenter', () => {
            previewEl.classList.add('resize-hover');
        });
        handle.addEventListener('mouseleave', () => {
            previewEl.classList.remove('resize-hover');
        });
    });

    // Mouse down handler
    previewEl.addEventListener('mousedown', (e) => {
        // Check if clicking on a resize handle
        const handle = e.target.closest('.resize-handle');
        if (handle) {
            isResizing = true;
            resizeHandle = handle.dataset.handle;
            previewEl.classList.add('resizing');
            document.body.style.cursor = 'ns-resize';
        } else {
            isDragging = true;
            previewEl.classList.add('dragging');
            document.body.style.cursor = 'grabbing';
        }

        startY = e.clientY;
        startX = e.clientX;
        startTop = parseFloat(previewEl.style.top) || 0;
        startHeight = parseFloat(previewEl.style.height) || 40;
        currentHoverTrack = track;

        // Calculate offset from track center where user clicked (for accurate day boundary detection)
        const trackRect = track.getBoundingClientRect();
        const trackCenterX = trackRect.left + trackRect.width / 2;
        clickOffsetX = e.clientX - trackCenterX;

        e.preventDefault();

        // Add mouse move and up handlers to document
        document.addEventListener('mousemove', handleMouseMove);
        document.addEventListener('mouseup', handleMouseUp);
    });

    function handleMouseMove(e) {
        const deltaY = e.clientY - startY;

        if (isDragging) {
            // Find all preview blocks for this segment
            const allSegmentBlocks = document.querySelectorAll(`.calendar-block.preview[data-segment-index="${segmentIndex}"]`);

            // Move all blocks vertically together
            const newTop = Math.max(0, startTop + deltaY);
            const maxTop = (24 * pixelsPerHour) - parseFloat(previewEl.style.height);
            const finalTop = Math.min(newTop, maxTop);

            allSegmentBlocks.forEach(block => {
                block.style.top = `${finalTop}px`;
                block.classList.add('dragging');
            });

            // Check if mouse is over a different day track - move all blocks together horizontally
            const allTracks = Array.from(document.querySelectorAll('.day-track'));
            let targetTrackIndex = -1;

            // Use offset-corrected position to detect which day we're over
            // This ensures the block moves when cursor crosses the day boundary, not before/after
            const effectiveX = e.clientX - clickOffsetX;

            for (let i = 0; i < allTracks.length; i++) {
                const rect = allTracks[i].getBoundingClientRect();
                const trackCenterX = rect.left + rect.width / 2;
                // Check if the effective center is within this track
                if (effectiveX >= rect.left && effectiveX <= rect.right) {
                    targetTrackIndex = i;
                    currentHoverTrack = allTracks[i];
                    break;
                }
            }

            if (targetTrackIndex >= 0) {
                // Calculate day shift from original track position
                const originalTrackIndex = allTracks.indexOf(track);
                const dayShiftDuringDrag = targetTrackIndex - originalTrackIndex;

                // Move all segment blocks to their shifted day positions
                allSegmentBlocks.forEach(block => {
                    // Get this block's original track (stored as data attribute or calculate from current position)
                    if (!block.dataset.originalTrackIndex) {
                        block.dataset.originalTrackIndex = allTracks.indexOf(block.parentElement);
                    }
                    const blockOriginalIndex = parseInt(block.dataset.originalTrackIndex);
                    const newTrackIndex = blockOriginalIndex + dayShiftDuringDrag;

                    // Move block to new track if in valid range
                    if (newTrackIndex >= 0 && newTrackIndex < allTracks.length) {
                        if (allTracks[newTrackIndex] !== block.parentElement) {
                            allTracks[newTrackIndex].appendChild(block);
                        }
                    }
                });
            }
        } else if (isResizing) {
            // Find all preview blocks for this segment
            const allSegmentBlocks = document.querySelectorAll(`.calendar-block.preview[data-segment-index="${segmentIndex}"]`);

            if (resizeHandle === 'top') {
                // Resize from top - adjust start time
                const newTop = Math.max(0, startTop + deltaY);
                const newHeight = startHeight - deltaY;
                if (newHeight >= 10) { // Minimum height
                    allSegmentBlocks.forEach(block => {
                        block.style.top = `${newTop}px`;
                        block.style.height = `${newHeight}px`;
                    });
                }
            } else if (resizeHandle === 'bottom') {
                // Resize from bottom - adjust end time
                const newHeight = Math.max(10, startHeight + deltaY);
                const maxHeight = (24 * pixelsPerHour) - startTop;
                const finalHeight = Math.min(newHeight, maxHeight);
                allSegmentBlocks.forEach(block => {
                    block.style.height = `${finalHeight}px`;
                });
            }
        }
    }

    function handleMouseUp(e) {
        document.removeEventListener('mousemove', handleMouseMove);
        document.removeEventListener('mouseup', handleMouseUp);

        // Remove classes and data from all blocks in this segment
        const allSegmentBlocks = document.querySelectorAll(`.calendar-block.preview[data-segment-index="${segmentIndex}"]`);
        allSegmentBlocks.forEach(block => {
            block.classList.remove('dragging');
            block.classList.remove('resizing');
            delete block.dataset.originalTrackIndex;
        });
        document.body.style.cursor = '';

        if (isDragging || isResizing) {
            // Calculate new times based on final position
            const finalTop = parseFloat(previewEl.style.top) || 0;
            const finalHeight = parseFloat(previewEl.style.height) || 40;

            const newStartMinutes = snapToInterval(pixelsToMinutes(finalTop));
            const newEndMinutes = snapToInterval(pixelsToMinutes(finalTop + finalHeight));

            // Calculate day shift if block was moved to different day
            let dayShift = 0;
            if (isDragging && currentHoverTrack !== track) {
                const newDayIndex = getDayIndexFromTrack(currentHoverTrack);
                if (newDayIndex !== null && startDayIndex !== null) {
                    dayShift = newDayIndex - startDayIndex;
                }
            }

            updateSegmentTimesAndDays(newStartMinutes, newEndMinutes, dayShift);
        }

        isDragging = false;
        isResizing = false;
        resizeHandle = null;
    }
}

// Handle blocklist selection
function handleBlocklistSelect(e) {
    const newBlocklistId = e.target.value || null;

    // Before switching, save pending changes for the current blocklist
    if (selectedBlocklistId) {
        // Save pending schedule segments if in schedule mode
        if (isScheduleMode) {
            const existingSchedule = appData.schedules?.find(s => s.blocklistId === selectedBlocklistId);
            if (!appData.settings) appData.settings = {};
            if (!appData.settings.pendingScheduleSegments) appData.settings.pendingScheduleSegments = {};

            if (!existingSchedule) {
                // No active schedule - save all segments
                if (scheduleSegments.length > 0) {
                    appData.settings.pendingScheduleSegments[selectedBlocklistId] = scheduleSegments.map(seg => ({ ...seg }));
                    saveData();
                }
            } else {
                // Active schedule exists - save only NEW segments (those beyond activeScheduleSegmentCount)
                if (scheduleSegments.length > activeScheduleSegmentCount) {
                    const newSegments = scheduleSegments.slice(activeScheduleSegmentCount);
                    appData.settings.pendingScheduleSegments[selectedBlocklistId] = newSegments.map(seg => ({ ...seg }));
                    saveData();
                } else {
                    // No new segments - clear any pending segments
                    if (appData.settings.pendingScheduleSegments[selectedBlocklistId]) {
                        delete appData.settings.pendingScheduleSegments[selectedBlocklistId];
                        saveData();
                    }
                }
            }
        } else {
            // Save pending instant block duration if in instant mode
            if (!appData.settings) appData.settings = {};
            if (!appData.settings.instantBlockDuration) appData.settings.instantBlockDuration = {};
            if (targetDurationMinutes !== 60) { // Only save if different from default
                appData.settings.instantBlockDuration[selectedBlocklistId] = targetDurationMinutes;
                saveData();
            }
        }
    }

    selectedBlocklistId = newBlocklistId;

    const timePicker = document.getElementById('time-picker-container');
    const passwordHint = document.getElementById('password-hint');
    const selectionPrompt = document.getElementById('selection-prompt');
    const startBlockBtn = document.getElementById('start-block-btn');
    const startScheduleBtn = document.getElementById('start-schedule-btn');
    const modeTabs = document.querySelector('.scheduler-mode-tabs');

    if (selectedBlocklistId) {
        // Determine which mode to show based on active blocks/schedules
        const blocklist = appData.blocklists.find(bl => bl.id === selectedBlocklistId);
        const now = Date.now();

        // Check if there's an active block (one-off)
        const hasActiveBlock = blocklist && appData.activeBlocks.some(b =>
            b.blocklistId === selectedBlocklistId && b.startTime <= now && b.endTime > now
        );

        // Check if there's an active schedule
        const existingSchedule = appData.schedules
            ? appData.schedules.find(s => s.blocklistId === selectedBlocklistId)
            : null;
        const hasActiveSchedule = existingSchedule && existingSchedule.segments && existingSchedule.segments.length > 0;

        // Determine default mode:
        if (hasActiveBlock && !hasActiveSchedule) {
            setScheduleMode(false);
        } else if (hasActiveSchedule && !hasActiveBlock) {
            setScheduleMode(true);
        } else if (hasActiveBlock && hasActiveSchedule) {
            setScheduleMode(false);
        } else {
            setScheduleMode(false);
        }

        // Hide selection prompt, show time picker, hint, tabs, and appropriate button
        if (selectionPrompt) selectionPrompt.classList.add('hidden');
        timePicker.classList.remove('hidden');
        if (passwordHint) passwordHint.classList.remove('hidden');
        if (modeTabs) modeTabs.classList.remove('hidden');

        // Show the appropriate button based on mode
        if (isScheduleMode) {
            if (startBlockBtn) startBlockBtn.classList.add('hidden');
            if (startScheduleBtn) {
                startScheduleBtn.classList.remove('hidden');
                updateScheduleButtonState();
            }
        } else {
            if (startScheduleBtn) startScheduleBtn.classList.add('hidden');
            if (startBlockBtn) {
                startBlockBtn.classList.remove('hidden');

                const blocklist = appData.blocklists.find(bl => bl.id === selectedBlocklistId);
                const now = Date.now();
                // IMPORTANT: Only find active block for THIS specific blocklist
                const activeBlock = appData.activeBlocks.find(b =>
                    b.blocklistId === selectedBlocklistId &&
                    b.startTime <= now &&
                    b.endTime > now
                );

                if (blocklist) {
                    const btnLabel = startBlockBtn.querySelector('.btn-label');
                    const btnName = startBlockBtn.querySelector('.btn-name');
                    const btnIcon = startBlockBtn.querySelector('svg');

                    // Always clear the activeBlockId first to prevent cross-blocklist issues
                    delete startBlockBtn.dataset.activeBlockId;
                    startBlockBtn.classList.remove('stop-block');

                    if (activeBlock) {
                        // Active block - show Stop Block button (grey) with unlock icon
                        if (btnLabel) btnLabel.textContent = 'Stop Block:';
                        if (btnName) btnName.textContent = blocklist.name;
                        startBlockBtn.classList.add('stop-block');
                        startBlockBtn.disabled = false;
                        startBlockBtn.dataset.activeBlockId = activeBlock.id;

                        // Change to unlock icon
                        if (btnIcon) {
                            btnIcon.innerHTML = `
                                <rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect>
                                <path d="M7 11V7a5 5 0 0 1 9.9-1"></path>
                            `;
                        }

                        // Disable time controls
                        disableTimeControls(true);
                    } else {
                        // No active block - show Start Block button (normal) with lock icon
                        // Ensure we've already cleared the activeBlockId above
                        if (btnLabel) btnLabel.textContent = 'Start Block:';
                        if (btnName) btnName.textContent = blocklist.name;

                        // Change to lock icon
                        if (btnIcon) {
                            btnIcon.innerHTML = `
                                <rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect>
                                <path d="M7 11V7a5 5 0 0 1 10 0v4"></path>
                            `;
                        }

                        // Enable time controls
                        disableTimeControls(false);
                    }
                }
            }
        }
        initializeTimeInputs();
    } else {
        // Show selection prompt, hide time picker, hint, tabs, and both buttons
        if (selectionPrompt) selectionPrompt.classList.remove('hidden');
        timePicker.classList.add('hidden');
        if (passwordHint) passwordHint.classList.add('hidden');
        if (modeTabs) modeTabs.classList.add('hidden');
        if (startBlockBtn) startBlockBtn.classList.add('hidden');
        if (startScheduleBtn) startScheduleBtn.classList.add('hidden');
    }

    // Update visual selection state on blocklist cards
    renderBlocklists();

    handleTimeChange(); // Update button state and preview

    // Wait for DOM reflow to capture the correct height after showing/hiding elements
    setTimeout(() => {
        updateWindowHeight();
    }, 50);
}

// Show start block confirmation modal
function startBlock() {
    if (!selectedBlocklistId) return;

    const blocklist = appData.blocklists.find(bl => bl.id === selectedBlocklistId);
    if (!blocklist) return;

    // Check if this is a "Stop Block" action (button is in stop mode)
    const startBlockBtn = document.getElementById('start-block-btn');
    if (startBlockBtn && startBlockBtn.dataset.activeBlockId) {
        // Verify the activeBlockId belongs to the currently selected blocklist
        const activeBlock = appData.activeBlocks.find(b =>
            b.id === startBlockBtn.dataset.activeBlockId &&
            b.blocklistId === selectedBlocklistId
        );

        if (activeBlock) {
            // Open override dialog instead of starting a new block
            openOverrideModal(startBlockBtn.dataset.activeBlockId);
            return;
        } else {
            // ActiveBlockId doesn't match selected blocklist - clear it and continue
            delete startBlockBtn.dataset.activeBlockId;
            startBlockBtn.classList.remove('stop-block');
        }
    }

    // Get times for display
    let blockStart = getStartTimeAsDate();
    let blockEnd = getEndTimeAsDate();
    if (blockEnd <= blockStart) {
        blockEnd.setDate(blockEnd.getDate() + 1);
    }

    // Calculate duration for display
    const durationMs = blockEnd.getTime() - blockStart.getTime();
    const durationMinutes = Math.round(durationMs / 60000);
    const hours = Math.floor(durationMinutes / 60);
    const mins = durationMinutes % 60;
    let durationText = '';
    if (hours > 0 && mins > 0) {
        durationText = `${hours}h ${mins}m`;
    } else if (hours > 0) {
        durationText = `${hours} hour${hours > 1 ? 's' : ''}`;
    } else {
        durationText = `${mins} minute${mins > 1 ? 's' : ''}`;
    }

    // Populate blocklist name
    document.getElementById('start-confirm-name').textContent = blocklist.name;

    // Populate duration
    document.getElementById('start-confirm-duration').textContent = durationText;

    // Helper to format list with show all
    const formatListWithShowAll = (items, elementId, showAllBtnId, rowId) => {
        const valueEl = document.getElementById(elementId);
        const showAllBtn = document.getElementById(showAllBtnId);
        const rowEl = document.getElementById(rowId);

        if (!items || items.length === 0) {
            rowEl.classList.add('hidden');
            return;
        }

        rowEl.classList.remove('hidden');

        if (items.length <= 3) {
            valueEl.textContent = items.map(cleanUrlForDisplay).join(', ');
            showAllBtn.classList.add('hidden');
        } else {
            const displayItems = items.slice(0, 3).map(cleanUrlForDisplay);
            valueEl.textContent = displayItems.join(', ') + ', ...';
            showAllBtn.classList.remove('hidden');
            showAllBtn.onclick = () => {
                valueEl.textContent = items.map(cleanUrlForDisplay).join(', ');
                showAllBtn.classList.add('hidden');
            };
        }
    };

    // Populate websites
    formatListWithShowAll(blocklist.websites, 'start-confirm-websites', 'show-all-websites', 'websites-row');

    // Populate apps (apps don't need URL cleaning)
    const appsValueEl = document.getElementById('start-confirm-apps');
    const showAllAppsBtn = document.getElementById('show-all-apps');
    const appsRowEl = document.getElementById('apps-row');

    if (!blocklist.apps || blocklist.apps.length === 0) {
        appsRowEl.classList.add('hidden');
    } else {
        appsRowEl.classList.remove('hidden');
        if (blocklist.apps.length <= 3) {
            appsValueEl.textContent = blocklist.apps.join(', ');
            showAllAppsBtn.classList.add('hidden');
        } else {
            appsValueEl.textContent = blocklist.apps.slice(0, 3).join(', ') + ', ...';
            showAllAppsBtn.classList.remove('hidden');
            showAllAppsBtn.onclick = () => {
                appsValueEl.textContent = blocklist.apps.join(', ');
                showAllAppsBtn.classList.add('hidden');
            };
        }
    }

    // Build override difficulty text with time estimate
    const difficulty = blocklist.overrideDifficulty || { type: 'random-words', count: 50 };
    let overrideText = '';

    // Estimate typing time: ~20 chars/min for random/gibberish (it's slow!), ~30 for custom text
    let charCount = difficulty.count;
    let charsPerMinute = 150; // Conservative for random words (average typing is ~200 chars/min)

    if (difficulty.type === 'custom' && difficulty.customText) {
        charCount = difficulty.customText.length;
        charsPerMinute = 200; // Custom text is slightly easier (you can see the pattern)
        const estimatedMinutes = Math.ceil(charCount / charsPerMinute);
        overrideText = `Type a specific ${charCount}-character phrase exactly as shown (~${estimatedMinutes} min).`;
    } else if (difficulty.type === 'gibberish') {
        charsPerMinute = 100; // Gibberish is the hardest
        const estimatedMinutes = Math.ceil(charCount / charsPerMinute);
        const charWord = charCount === 1 ? 'character' : 'characters';
        overrideText = `Type ${charCount} random ${charWord} (letters and numbers) exactly as shown (~${estimatedMinutes} min).`;
    } else {
        const estimatedMinutes = Math.ceil(charCount / charsPerMinute);
        const charWord = charCount === 1 ? 'character' : 'characters';
        overrideText = `Type ${charCount} ${charWord} (displayed as random words) exactly as shown (~${estimatedMinutes} min).`;
    }

    document.getElementById('start-confirm-override-text').textContent = overrideText;

    // Show modal
    document.getElementById('start-block-confirm-modal').classList.remove('hidden');
}

// Close start block confirmation modal
function closeStartBlockConfirmModal() {
    document.getElementById('start-block-confirm-modal').classList.add('hidden');
}

// Actually start a block (called after confirmation)
async function proceedWithBlock() {
    // Close confirmation modal
    closeStartBlockConfirmModal();

    const startBtn = document.getElementById('start-block-btn');

    if (!selectedBlocklistId) return;

    // Get times from the custom time picker
    let blockStart = getStartTimeAsDate();
    let blockEnd = getEndTimeAsDate();

    // If end is before or equal to start, assume end is next day
    if (blockEnd <= blockStart) {
        blockEnd.setDate(blockEnd.getDate() + 1);
    }

    // Disable button while processing
    startBtn.disabled = true;
    startBtn.textContent = 'Starting...';

    const blocklist = appData.blocklists.find(bl => bl.id === selectedBlocklistId);
    if (!blocklist) {
        startBtn.disabled = false;
        startBtn.innerHTML = getStartBlockButtonHTML();
        return;
    }

    const block = {
        id: generateId(),
        blocklistId: selectedBlocklistId,
        startTime: blockStart.getTime(),
        endTime: blockEnd.getTime()
    };

    let result;

    // Try to use the helper daemon (no password required!)
    if (helperAvailable) {
        result = await tauriAPI.startBlockViaHelper({
            domains: blocklist.websites || [],
            endTime: blockEnd.getTime(),
            blocklistId: selectedBlocklistId
        });
    } else {
        // Helper not available - check if it's installed but just not detected
        const status = await tauriAPI.checkHelperStatus();

        if (status.running && status.version_ok) {
            // It's running with correct version, use it
            helperAvailable = true;
            result = await tauriAPI.startBlockViaHelper({
                domains: blocklist.websites || [],
                endTime: blockEnd.getTime(),
                blocklistId: selectedBlocklistId
            });
        } else {
            // Helper not running, not installed, or outdated - show the install modal
            // The install flow will update an outdated helper
            if (status.running && !status.version_ok) {
                console.log('Helper is outdated, need to update - showing install modal');
            }
            pendingBlockData = {
                block,
                blocklist,
                blockEnd
            };
            document.getElementById('helper-install-modal').classList.remove('hidden');

            // Re-enable button and return - modal will handle the rest
            startBtn.disabled = false;
            startBtn.innerHTML = getStartBlockButtonHTML();
            return;
        }
    }

    if (!result.success) {
        // Re-enable button
        startBtn.disabled = false;
        startBtn.innerHTML = getStartBlockButtonHTML();

        // Only show error if user didn't cancel
        if (!result.cancelled) {
            alert('Could not start block: ' + (result.error || 'Unknown error'));
        }
        return;
    }

    // Add block to local data if using helper (which manages its own state)
    if (helperAvailable) {
        appData.activeBlocks.push(block);
        activatedBlockIds.add(block.id);
    }

    // Clear pending duration for this blocklist (it's now committed)
    if (appData.settings?.instantBlockDuration?.[selectedBlocklistId]) {
        delete appData.settings.instantBlockDuration[selectedBlocklistId];
    }

    // Save data and reset UI
    await saveData();

    // Update blocked apps (handles both active blocks and schedules)
    await updateBlockedApps();

    // Render UI to update blocklist cards (show ACTIVE badge)
    render();

    // Restore button HTML structure first (textContent = 'Starting...' wiped it)
    const startBtn2 = document.getElementById('start-block-btn');
    startBtn2.innerHTML = getStartBlockButtonHTML();
    startBtn2.disabled = false;

    // Ensure the blocklist stays selected in dropdown and update UI to show Stop Block button
    const blocklistSelect = document.getElementById('blocklist-select');
    blocklistSelect.value = selectedBlocklistId; // Make sure it's still set
    handleBlocklistSelect({ target: blocklistSelect });
}

// Helper function for start block button HTML (includes .btn-label and .btn-name for updateability)
function getStartBlockButtonHTML() {
    return `
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect>
            <path d="M7 11V7a5 5 0 0 1 10 0v4"></path>
        </svg>
        <span class="btn-label">Start Block:</span>
        <span class="btn-name"></span>
    `;
}

// Handle the Proceed button in the helper install modal
async function proceedWithHelperInstall() {
    const modal = document.getElementById('helper-install-modal');
    const proceedBtn = document.getElementById('proceed-helper-install-btn');

    // Disable button while installing with spinner
    proceedBtn.disabled = true;
    proceedBtn.innerHTML = '<span class="btn-spinner"></span>Installing...';

    // Try to install the helper
    const installResult = await tauriAPI.installHelper();

    if (installResult.success) {
        // Check if the helper is actually running
        if (!installResult.running) {
            // Helper installed but not running yet - this is the bug scenario
            // Wait a bit more and try again
            proceedBtn.innerHTML = '<span class="btn-spinner"></span>Starting helper...';

            // Additional wait with status check
            let helperReady = false;
            for (let i = 0; i < 5; i++) {
                await new Promise(resolve => setTimeout(resolve, 1000));
                const status = await tauriAPI.checkHelperStatus();
                if (status.running) {
                    helperReady = true;
                    break;
                }
            }

            if (!helperReady) {
                // Still not running - show a helpful error
                proceedBtn.disabled = false;
                proceedBtn.textContent = 'Proceed';
                alert('The helper was installed but is not running yet. Please try again, or restart your computer if the problem persists.');
                return;
            }
        }

        helperAvailable = true;
        modal.classList.add('hidden');

        // Now start the pending block
        if (pendingBlockData) {
            const { block, blocklist, blockEnd } = pendingBlockData;

            const result = await tauriAPI.startBlockViaHelper({
                domains: blocklist.websites || [],
                endTime: blockEnd.getTime(),
                blocklistId: blocklist.id
            });

            if (result.success) {
                // Add block to local data
                appData.activeBlocks.push(block);
                activatedBlockIds.add(block.id);
                await saveData();

                // Start watcher and update blocked apps (was missing - watcher never started on first block)
                await updateBlockedApps();

                // Reset UI - keep the blocklist selected
                const blocklistSelect = document.getElementById('blocklist-select');
                blocklistSelect.value = blocklist.id; // Keep the blocklist selected
                handleBlocklistSelect({ target: blocklistSelect });

                render();
            } else {
                alert('Could not start block: ' + (result.error || 'Unknown error'));
            }

            pendingBlockData = null;
        }
    } else {
        // Installation failed
        if (!installResult.error?.includes('Permission denied')) {
            alert('Could not install helper: ' + (installResult.error || 'Unknown error'));
        }
    }

    // Re-enable button
    proceedBtn.disabled = false;
    proceedBtn.textContent = 'Proceed';
}

// Update hosts file based on active blocks
// silent = true means don't prompt for password (used for cleanup)
async function updateHostsFile(silent = false) {
    const allDomains = new Set();
    const now = Date.now();

    // Only block domains for blocks that are currently active (startTime <= now && endTime > now)
    appData.activeBlocks
        .filter(block => block.startTime <= now && block.endTime > now)
        .forEach(block => {
            const blocklist = appData.blocklists.find(bl => bl.id === block.blocklistId);
            if (blocklist && blocklist.websites) {
                blocklist.websites.forEach(domain => allDomains.add(domain));
            }
        });

    // Also check scheduled blocks - add domains if a schedule segment is currently active
    const nowDate = new Date();
    const currentDay = nowDate.getDay() === 0 ? 6 : nowDate.getDay() - 1; // Convert to Mon=0 format
    const currentMins = nowDate.getHours() * 60 + nowDate.getMinutes();

    if (appData.schedules) {
        appData.schedules.forEach(schedule => {
            if (!schedule.segments) return;

            // Check if any segment is active right now
            const isActive = schedule.segments.some(seg => {
                const startMins = seg.startHour * 60 + seg.startMinute;
                const endMins = seg.endHour * 60 + seg.endMinute;

                if (endMins > startMins) {
                    // Same-day segment (e.g., 09:00 - 17:00)
                    return seg.days.includes(currentDay) &&
                        currentMins >= startMins &&
                        currentMins < endMins;
                } else {
                    // Cross-midnight segment (e.g., 22:00 - 04:00)
                    // Active if: (today is in days AND currentMins >= start)
                    //         OR (yesterday is in days AND currentMins < end)
                    const yesterdayDay = currentDay === 0 ? 6 : currentDay - 1;

                    const inEveningPortion = seg.days.includes(currentDay) && currentMins >= startMins;
                    const inMorningPortion = seg.days.includes(yesterdayDay) && currentMins < endMins;

                    return inEveningPortion || inMorningPortion;
                }
            });

            if (isActive) {
                const blocklist = appData.blocklists.find(bl => bl.id === schedule.blocklistId);
                if (blocklist && blocklist.websites) {
                    blocklist.websites.forEach(domain => allDomains.add(domain));
                }
            }
        });
    }

    // Check if domains actually changed
    const domainsArray = Array.from(allDomains).sort();
    const lastDomainsArray = Array.from(lastBlockedDomains).sort();
    const domainsChanged = JSON.stringify(domainsArray) !== JSON.stringify(lastDomainsArray);

    if (!domainsChanged) {
        return { success: true, unchanged: true };
    }

    // For silent updates (cleanup), skip if it would require password
    if (silent && allDomains.size < lastBlockedDomains.size) {
        // Domains are being removed - this still needs sudo unfortunately
        // For now, we'll defer cleanup until the app is explicitly used
        return { success: true, deferred: true };
    }

    // Try to use helper daemon first (works on all platforms)
    try {
        console.log('[updateHostsFile] Checking helper status...');
        const status = await tauriAPI.checkHelperStatus();
        console.log('[updateHostsFile] Helper status:', status);

        if (status.running && status.version_ok) {
            console.log('[updateHostsFile] Helper running with correct version, using helper to update blocks');
            helperAvailable = true;

            if (domainsArray.length === 0) {
                // Clear all blocks via helper
                const result = await tauriAPI.clearBlockViaHelper();
                if (result && result.success) {
                    lastBlockedDomains = allDomains;
                    // Update blocked apps (will stop watcher if no apps to block)
                    await updateBlockedApps();
                }
                return result || { success: true };
            } else {
                // Calculate end time - need to consider both activeBlocks and schedules
                let latestEndTime = null;

                // Check active blocks
                const activeBlockEndTimes = appData.activeBlocks
                    .filter(b => b.startTime <= now && b.endTime > now)
                    .map(b => b.endTime);

                if (activeBlockEndTimes.length > 0) {
                    latestEndTime = Math.max(...activeBlockEndTimes);
                }

                // For schedules, we don't have a fixed end time, so use end-of-day
                // or a reasonable default (if only schedules are blocking)
                if (latestEndTime === null && appData.schedules && appData.schedules.length > 0) {
                    // Use end of today as the endTime for schedule-only blocks
                    const endOfDay = new Date();
                    endOfDay.setHours(23, 59, 59, 999);
                    latestEndTime = endOfDay.getTime();
                }

                // Fallback if somehow still null
                if (latestEndTime === null) {
                    latestEndTime = now + (24 * 60 * 60 * 1000); // 24 hours from now
                }

                const result = await tauriAPI.startBlockViaHelper({
                    domains: domainsArray,
                    endTime: latestEndTime,
                    blocklistId: 'combined' // Multiple blocklists combined
                });
                if (result && result.success) {
                    lastBlockedDomains = allDomains;
                    // Update blocked apps based on active blocks and schedules
                    await updateBlockedApps();
                }
                return result || { success: true };
            }
        } else {
            console.log('[updateHostsFile] Helper NOT running, falling back');
        }
    } catch (e) {
        console.warn('Helper not available, falling back to direct method:', e);
    }

    // Fallback to direct hosts file modification (macOS)
    console.log('[updateHostsFile] Calling fallback block-websites');
    const result = await tauriAPI.blockWebsites(domainsArray);

    if (result && result.success) {
        lastBlockedDomains = allDomains;
        // Update blocked apps based on active blocks and schedules
        await updateBlockedApps();
    }

    return result || { success: true };
}

// Update blocked apps list based on active blocks and schedules
async function updateBlockedApps() {
    const allBlockedApps = new Set();
    const now = Date.now();
    const nowDate = new Date();
    const currentDay = nowDate.getDay() === 0 ? 6 : nowDate.getDay() - 1; // Convert to Mon=0 format
    const currentMins = nowDate.getHours() * 60 + nowDate.getMinutes();

    // Collect apps from active one-off blocks
    appData.activeBlocks
        .filter(block => block.startTime <= now && block.endTime > now)
        .forEach(block => {
            const blocklist = appData.blocklists.find(bl => bl.id === block.blocklistId);
            if (blocklist && blocklist.apps) {
                blocklist.apps.forEach(app => allBlockedApps.add(app));
            }
        });

    // Collect apps from active schedules
    if (appData.schedules) {
        appData.schedules.forEach(schedule => {
            if (!schedule.segments) return;

            // Check if any segment is active right now
            const isActive = schedule.segments.some(seg => {
                const startMins = seg.startHour * 60 + seg.startMinute;
                const endMins = seg.endHour * 60 + seg.endMinute;

                if (endMins > startMins) {
                    // Same-day segment (e.g., 09:00 - 17:00)
                    return seg.days.includes(currentDay) &&
                        currentMins >= startMins &&
                        currentMins < endMins;
                } else {
                    // Cross-midnight segment (e.g., 22:00 - 04:00)
                    const yesterdayDay = currentDay === 0 ? 6 : currentDay - 1;
                    const inEveningPortion = seg.days.includes(currentDay) && currentMins >= startMins;
                    const inMorningPortion = seg.days.includes(yesterdayDay) && currentMins < endMins;
                    return inEveningPortion || inMorningPortion;
                }
            });

            if (isActive) {
                const blocklist = appData.blocklists.find(bl => bl.id === schedule.blocklistId);
                if (blocklist && blocklist.apps) {
                    blocklist.apps.forEach(app => allBlockedApps.add(app));
                }
            }
        });
    }

    const appsArray = Array.from(allBlockedApps).sort();
    const lastAppsArray = Array.from(lastBlockedApps).sort();
    const appsChanged = JSON.stringify(appsArray) !== JSON.stringify(lastAppsArray);

    // Skip if nothing changed (avoid redundant PowerShell calls every tick)
    if (!appsChanged) {
        return;
    }

    // Update cache
    lastBlockedApps = allBlockedApps;

    // Update the blocked apps list
    if (appsArray.length > 0) {
        console.log('[updateBlockedApps] Setting blocked apps:', appsArray);
        await tauriAPI.setBlockedApps(appsArray);

        // Start process watcher if not already running
        await tauriAPI.startProcessWatcher();

        // Hide any currently open blocked apps (only on change)
        await tauriAPI.hideAllBlockedApps();
    } else {
        // No apps to block - stop the process watcher and clear the list
        console.log('[updateBlockedApps] No apps to block, clearing');
        await tauriAPI.stopProcessWatcher();
        await tauriAPI.setBlockedApps([]);
    }
}

// Open blocklist modal
function openBlocklistModal(blocklist = null) {
    editingBlocklistId = blocklist?.id || null;

    document.getElementById('modal-title').textContent = blocklist ? 'Edit Blocklist' : 'Create Blocklist';

    document.getElementById('blocklist-name').value = blocklist?.name || '';

    document.getElementById('override-type').value = blocklist?.overrideDifficulty?.type || 'random-words';
    document.getElementById('override-count').value = blocklist?.overrideDifficulty?.count || 10;
    document.getElementById('custom-override-text').value = blocklist?.overrideDifficulty?.customText || '';

    const type = blocklist?.overrideDifficulty?.type || 'random-words';
    const customTextArea = document.getElementById('custom-override-text');
    const overrideCountWrapper = document.getElementById('override-count-wrapper');
    const hintEl = document.getElementById('override-count-hint');

    if (type === 'custom') {
        customTextArea.classList.remove('hidden');
        overrideCountWrapper.classList.add('hidden');
        hintEl.classList.add('hidden');
    } else {
        customTextArea.classList.add('hidden');
        overrideCountWrapper.classList.remove('hidden');
        hintEl.classList.remove('hidden');

        if (type === 'random-words') {
            hintEl.innerHTML = "E.g. 10 chars → 'shine great'";
        } else {
            hintEl.innerHTML = "E.g. 10 chars → 'a982j3+fd'";
        }
    }

    // Restore color swatch selection
    document.querySelectorAll('.color-swatch').forEach(s => s.classList.remove('selected'));

    let colorToSelect = blocklist?.color;

    // If creating a new blocklist (or no color set), find the first unused color
    if (!colorToSelect) {
        const usedColors = new Set(appData.blocklists.map(bl => bl.color));
        const swatches = Array.from(document.querySelectorAll('.color-swatch:not(.custom-swatch)'));

        // Find first color from the palette that isn't used
        const firstUnused = swatches.find(s => !usedColors.has(s.dataset.color));

        if (firstUnused) {
            colorToSelect = firstUnused.dataset.color;
        } else if (swatches.length > 0) {
            // If all are used, wrap around to the first one
            colorToSelect = swatches[0].dataset.color;
        } else {
            // Fallback default
            colorToSelect = 'linear-gradient(135deg, #4a00e0 0%, #8e2de2 100%)';
        }
    }

    const matchingSwatch = document.querySelector(`.color-swatch[data-color="${colorToSelect}"]:not(.custom-swatch)`);
    if (matchingSwatch) {
        matchingSwatch.classList.add('selected');
    } else {
        // Must be a custom color
        const customSwatch = document.getElementById('custom-color-swatch');
        if (customSwatch) {
            customSwatch.style.background = colorToSelect;
            customSwatch.dataset.color = colorToSelect;
            customSwatch.classList.add('selected');
        }
    }

    // Restore emoji swatch selection
    document.querySelectorAll('.emoji-swatch').forEach(s => s.classList.remove('selected'));

    let emojiToSelect = blocklist?.emoji;

    // If creating a new blocklist (or no emoji set), find the first unused emoji
    if (!emojiToSelect) {
        const usedEmojis = new Set(appData.blocklists.map(bl => bl.emoji));
        const emojiSwatches = Array.from(document.querySelectorAll('.emoji-swatch:not(.custom-emoji-swatch)'));

        // Find first emoji from the palette that isn't used
        const firstUnused = emojiSwatches.find(s => !usedEmojis.has(s.dataset.emoji));

        if (firstUnused) {
            emojiToSelect = firstUnused.dataset.emoji;
        } else if (emojiSwatches.length > 0) {
            // If all are used, wrap around to the first one
            emojiToSelect = emojiSwatches[0].dataset.emoji;
        } else {
            // Fallback default
            emojiToSelect = '🚫';
        }
    }

    const matchingEmoji = document.querySelector(`.emoji-swatch[data-emoji="${emojiToSelect}"]:not(.custom-emoji-swatch)`);
    if (matchingEmoji) {
        matchingEmoji.classList.add('selected');
    } else {
        // Must be a custom emoji
        const customEmojiSwatch = document.getElementById('custom-emoji-swatch');
        if (customEmojiSwatch) {
            customEmojiSwatch.innerHTML = emojiToSelect;
            customEmojiSwatch.dataset.emoji = emojiToSelect;
            customEmojiSwatch.classList.add('selected');
        }
    }

    // Check if active (block or schedule)
    const now = Date.now();
    const hasActiveBlock = blocklist?.id && appData.activeBlocks.some(
        b => b.blocklistId === blocklist.id && b.startTime <= now && b.endTime > now
    );
    const hasActiveSchedule = blocklist?.id && appData.schedules?.some(
        s => s.blocklistId === blocklist.id && s.segments && s.segments.length > 0
    );
    const isActive = hasActiveBlock || hasActiveSchedule;

    const warningEl = document.getElementById('active-blocklist-warning');
    const modeInputs = document.getElementById('blocklist-modal').querySelectorAll('.radio-option');
    const overrideInputs = [
        document.getElementById('override-type'),
        document.getElementById('override-count'),
        document.getElementById('custom-override-text')
    ];

    // Get override elements for styling
    const overrideTypeSelect = document.getElementById('override-type');
    const overrideCountInput = document.getElementById('override-count');
    const overrideCountWrapperEl = document.getElementById('override-count-wrapper');
    const inputSuffix = overrideCountWrapperEl?.querySelector('.input-suffix');

    if (isActive) {
        warningEl.classList.remove('hidden');
        modeInputs.forEach(el => el.classList.add('disabled'));
        overrideInputs.forEach(el => el.disabled = true);

        // Style override type dropdown (like repeat dropdown)
        if (overrideTypeSelect) {
            overrideTypeSelect.classList.add('form-select-disabled');
        }

        // Style override count input (like repeat dropdown)
        if (overrideCountInput) {
            overrideCountInput.classList.add('form-input-disabled');
        }

        // Style the "total characters" text (same color as Start/End labels)
        if (inputSuffix) {
            inputSuffix.classList.add('input-suffix-disabled');
        }

        // Pass existing items as locked
        window.setModalData(blocklist.websites || [], blocklist.apps || [], blocklist.websites || [], blocklist.apps || []);
    } else {
        warningEl.classList.add('hidden');
        modeInputs.forEach(el => el.classList.remove('disabled'));
        overrideInputs.forEach(el => el.disabled = false);

        // Remove disabled styling
        if (overrideTypeSelect) {
            overrideTypeSelect.classList.remove('form-select-disabled');
        }
        if (overrideCountInput) {
            overrideCountInput.classList.remove('form-input-disabled');
        }
        if (inputSuffix) {
            inputSuffix.classList.remove('input-suffix-disabled');
        }

        window.setModalData(blocklist?.websites || [], blocklist?.apps || [], [], []);
    }

    // Set advanced options - default to checked (true) if not set
    const showItemDetailsCheckbox = document.getElementById('show-item-details-checkbox');
    if (showItemDetailsCheckbox) {
        showItemDetailsCheckbox.checked = blocklist?.showItemDetails !== false;
    }

    const alwaysShowInScheduleCheckbox = document.getElementById('always-show-in-schedule-checkbox');
    if (alwaysShowInScheduleCheckbox) {
        alwaysShowInScheduleCheckbox.checked = blocklist?.alwaysShowInSchedule !== false;
    }

    // Reset advanced options to collapsed state
    const blocklistAdvancedToggle = document.getElementById('blocklist-advanced-toggle');
    const blocklistAdvancedContent = document.getElementById('blocklist-advanced-content');
    if (blocklistAdvancedToggle && blocklistAdvancedContent) {
        blocklistAdvancedToggle.classList.remove('expanded');
        blocklistAdvancedContent.classList.add('hidden');
    }

    document.getElementById('blocklist-modal').classList.remove('hidden');

    // Reset scroll position after modal is shown
    const modalContent = document.querySelector('#blocklist-modal .modal-content');
    if (modalContent) modalContent.scrollTop = 0;
}

// Close blocklist modal
function closeBlocklistModal() {
    document.getElementById('blocklist-modal').classList.add('hidden');
    editingBlocklistId = null;
    document.getElementById('blocklist-name').value = '';
    window.setModalData([], []);
}

// Open override modal
function openOverrideModal(blockId) {
    overrideBlockId = blockId;

    const block = appData.activeBlocks.find(b => b.id === blockId);
    const blocklist = appData.blocklists.find(bl => bl.id === block?.blocklistId);

    if (!blocklist) return;

    // Set modal title with blocklist name
    document.getElementById('override-modal-title').textContent = `Override ${blocklist.name}?`;

    // Set summary text
    const websiteCount = blocklist.websites?.length || 0;
    const appCount = blocklist.apps?.length || 0;
    const mode = blocklist.mode === 'allowlist' ? 'Allows' : 'Blocks';

    let metaParts = [];

    if (websiteCount > 0) {
        const displaySites = blocklist.websites.map(cleanUrlForDisplay);
        if (websiteCount <= 2) {
            metaParts.push(`${websiteCount} ${websiteCount === 1 ? 'website' : 'websites'} (${displaySites.join(', ')})`);
        } else {
            metaParts.push(`${websiteCount} websites (${displaySites.slice(0, 2).join(', ')}, ...)`);
        }
    }

    if (appCount > 0) {
        if (appCount <= 2) {
            metaParts.push(`${appCount} ${appCount === 1 ? 'app' : 'apps'} (${blocklist.apps.join(', ')})`);
        } else {
            metaParts.push(`${appCount} apps (${blocklist.apps.slice(0, 2).join(', ')}, ...)`);
        }
    }

    const itemsText = metaParts.length > 0 ? metaParts.join(' and ') : 'nothing';
    document.getElementById('override-summary').textContent = `${mode} ${itemsText}`;

    const difficulty = blocklist.overrideDifficulty || { type: 'random-words', count: 50 };

    // Generate challenge text
    if (difficulty.type === 'custom' && difficulty.customText) {
        challengeText = difficulty.customText;
    } else if (difficulty.type === 'gibberish') {
        challengeText = generateGibberish(difficulty.count);
    } else {
        challengeText = generateRandomWords(difficulty.count);
    }

    // Sanitize: remove linebreaks and collapse multiple spaces
    challengeText = challengeText.replace(/[\r\n]+/g, ' ').replace(/\s{2,}/g, ' ').trim();

    document.getElementById('challenge-text').textContent = challengeText;
    document.getElementById('challenge-input').value = '';

    const progressBar = document.getElementById('challenge-progress-bar');
    progressBar.style.width = '0%';
    // Use the blocklist's color for the progress bar
    if (blocklist.color) {
        progressBar.style.background = blocklist.color;
    } else {
        progressBar.style.background = 'linear-gradient(90deg, #667eea 0%, #764ba2 100%)';
    }

    // Reset wiggle state
    document.querySelector('#override-modal .modal-content').classList.remove('wiggle');

    document.getElementById('override-modal').classList.remove('hidden');
}

// Close override modal
function closeOverrideModal() {
    document.getElementById('override-modal').classList.add('hidden');
    overrideBlockId = null;
    challengeText = '';
}

// Generate random words to reach target character count
// Generate random words to reach target character count exactly
function generateRandomWords(targetChars) {
    const words = [];
    let currentLength = 0;

    // Safety break to prevent infinite loops
    let attempts = 0;
    const maxAttempts = 1000;

    while (currentLength < targetChars && attempts < maxAttempts) {
        attempts++;

        const isFirstWord = words.length === 0;
        const spaceNeeded = isFirstWord ? 0 : 1;
        const remaining = targetChars - currentLength;
        const maxWordLen = remaining - spaceNeeded;

        if (maxWordLen <= 0) break;

        // Try to find exact fit first
        const exactMatches = wordList.filter(w => w.length === maxWordLen);

        if (exactMatches.length > 0) {
            // Found exact match! Finish here.
            const word = exactMatches[Math.floor(Math.random() * exactMatches.length)];
            words.push(word);
            currentLength += spaceNeeded + word.length;
            break;
        } else {
            // No exact match, pick a random word that fits and leaves room for at least 1 more char 
            // (technically min word size is 1, so space+1=2 chars required for next step)

            const validWords = wordList.filter(w => {
                const newRemaining = remaining - (spaceNeeded + w.length);
                return newRemaining >= 2;
            });

            if (validWords.length > 0) {
                const word = validWords[Math.floor(Math.random() * validWords.length)];
                words.push(word);
                currentLength += spaceNeeded + word.length;
            } else {
                // If we're stuck (cannot find a word that fits exactly AND cannot find one leaving >=2 chars),
                // it means we have e.g. 1 char left (after space) but no 1-char words? 
                // With our list containing 'a', this shouldn't happen unless we need a 0-length word.
                break;
            }
        }
    }

    return words.join(' ');
}

// Generate gibberish
function generateGibberish(count) {
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    let result = '';
    for (let i = 0; i < count; i++) {
        result += chars[Math.floor(Math.random() * chars.length)];
    }
    return result;
}

// Delete blocklist with undo support
let pendingDelete = null; // { blocklist, activeBlocks, timeoutId }

async function deleteBlocklist(id) {
    const blocklist = appData.blocklists.find(bl => bl.id === id);
    if (!blocklist) return;

    // Check if this blocklist has an active block or schedule running
    const now = Date.now();
    const hasActiveBlock = appData.activeBlocks.some(
        block => block.blocklistId === id && block.startTime <= now && block.endTime > now
    );
    const hasActiveSchedule = appData.schedules?.some(
        s => s.blocklistId === id && s.segments && s.segments.length > 0
    );

    if (hasActiveBlock) {
        alert(`Cannot delete "${blocklist.name}" while a block is running. Override the block first.`);
        return;
    }

    if (hasActiveSchedule) {
        alert(`Cannot delete "${blocklist.name}" while a schedule is active. Stop the schedule first.`);
        return;
    }

    // If there's already a pending delete, commit it first
    if (pendingDelete) {
        commitDelete();
    }

    // Store the blocklist and any active blocks for potential undo
    const activeBlocksToRemove = appData.activeBlocks.filter(b => b.blocklistId === id);

    // Remove from data (soft delete)
    appData.blocklists = appData.blocklists.filter(bl => bl.id !== id);
    appData.activeBlocks = appData.activeBlocks.filter(b => b.blocklistId !== id);

    // If the deleted blocklist was the selected one, reset the scheduler UI
    if (selectedBlocklistId === id) {
        selectedBlocklistId = null;
        const blocklistSelect = document.getElementById('blocklist-select');
        blocklistSelect.value = '';
        handleBlocklistSelect({ target: blocklistSelect });
    }

    // Re-render immediately
    render();

    // Show undo toast
    const toast = document.getElementById('undo-toast');
    const message = document.getElementById('undo-toast-message');
    message.textContent = `Deleted "${blocklist.name}"`;
    toast.classList.remove('hidden');

    // Set up auto-commit after 5 seconds
    const timeoutId = setTimeout(() => {
        commitDelete();
    }, 5000);

    pendingDelete = {
        blocklist,
        activeBlocks: activeBlocksToRemove,
        timeoutId
    };
}

function commitDelete() {
    if (!pendingDelete) return;

    clearTimeout(pendingDelete.timeoutId);

    // Save data permanently
    saveData();

    // Update hosts if needed
    if (pendingDelete.activeBlocks.length > 0) {
        updateHostsFile();
    }

    // Hide toast
    document.getElementById('undo-toast').classList.add('hidden');
    pendingDelete = null;
}

function undoDelete() {
    if (!pendingDelete) return;

    clearTimeout(pendingDelete.timeoutId);

    // Restore the blocklist and active blocks
    appData.blocklists.push(pendingDelete.blocklist);
    pendingDelete.activeBlocks.forEach(block => {
        appData.activeBlocks.push(block);
    });

    // Hide toast
    document.getElementById('undo-toast').classList.add('hidden');
    pendingDelete = null;

    // Re-render
    render();
}

// Main render function
function render() {
    // Show onboarding if not complete - window size is set in main.js
    if (!appData.settings.onboardingComplete) {
        document.getElementById('onboarding-screen').classList.remove('hidden');
        document.getElementById('main-content').classList.add('hidden');
        return;
    }

    document.getElementById('onboarding-screen').classList.add('hidden');
    document.getElementById('main-content').classList.remove('hidden');

    // Initialize currentWeekStart if not set
    if (!currentWeekStart) {
        currentWeekStart = getWeekStart(new Date());
    }

    updateWeekCalendar();
    renderWeekBlocks();
    renderBlocklistSelector();

    // Auto-select if there's only one available (non-active) blocklist
    if (!selectedBlocklistId) {
        const activeIds = appData.activeBlocks.map(b => b.blocklistId);
        const availableBlocklists = appData.blocklists.filter(bl => !activeIds.includes(bl.id));
        if (availableBlocklists.length === 1) {
            const dropdown = document.getElementById('blocklist-select');
            dropdown.value = availableBlocklists[0].id;
            handleBlocklistSelect({ target: dropdown });
        }
    }

    renderBlocklists();

    // Hide "Select a blocklist" prompt if there are no blocklists
    const selectionPrompt = document.getElementById('selection-prompt');
    if (selectionPrompt) {
        if (appData.blocklists.length === 0) {
            selectionPrompt.classList.add('hidden');
        } else if (!selectedBlocklistId) {
            // Only show prompt if there are blocklists but none selected
            selectionPrompt.classList.remove('hidden');
        }
    }

    // Adjust window height to fit content
    updateWindowHeight();
}

// Get the Monday of the week containing the given date
function getWeekStart(date) {
    const d = new Date(date);
    const day = d.getDay();
    const diff = d.getDate() - day + (day === 0 ? -6 : 1); // Adjust when day is Sunday
    d.setDate(diff);
    d.setHours(0, 0, 0, 0);
    return d;
}

// Format week display string like "Mon 26 Jan - Sun 1 Feb"
function formatWeekDisplay(start, end) {
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

    const startDay = days[start.getDay()];
    const startDate = start.getDate();
    const startMonth = months[start.getMonth()];

    const endDay = days[end.getDay()];
    const endDate = end.getDate();
    const endMonth = months[end.getMonth()];

    // Include year if different from current
    const currentYear = new Date().getFullYear();
    const startYear = start.getFullYear();
    const endYear = end.getFullYear();

    if (startMonth === endMonth && startYear === endYear) {
        const yearSuffix = startYear !== currentYear ? ` ${startYear}` : '';
        return `${startDay} ${startDate} - ${endDay} ${endDate} ${startMonth}${yearSuffix}`;
    } else if (startYear === endYear) {
        const yearSuffix = startYear !== currentYear ? ` ${startYear}` : '';
        return `${startDay} ${startDate} ${startMonth} - ${endDay} ${endDate} ${endMonth}${yearSuffix}`;
    } else {
        return `${startDay} ${startDate} ${startMonth} ${startYear} - ${endDay} ${endDate} ${endMonth} ${endYear}`;
    }
}

// Navigate to previous/next week
function navigateWeek(direction) {
    if (!currentWeekStart) {
        currentWeekStart = getWeekStart(new Date());
    }

    currentWeekStart.setDate(currentWeekStart.getDate() + (direction * 7));
    updateWeekCalendar();
    renderWeekBlocks();
    handleTimeChange(); // Re-render preview block after navigation
}

// Scroll to today's column and current time
function scrollToToday(smooth = true) {
    const today = new Date();
    const todayStart = getWeekStart(today);

    // If today is not in the current week, navigate to it first
    if (currentWeekStart.getTime() !== todayStart.getTime()) {
        currentWeekStart = todayStart;
        updateWeekCalendar();
        renderWeekBlocks();
        handleTimeChange(); // Re-render preview block after navigation
    }

    const scrollContainer = document.querySelector('.week-calendar-scroll');
    if (!scrollContainer) return;

    // Scroll to today's column (horizontal)
    const todayColumn = document.querySelector('.day-column.today');
    const headerTimeSpacerWidth = 50; // width of time spacer in header

    if (todayColumn) {
        // Calculate horizontal scroll: offset from left of content area
        const scrollTargetX = todayColumn.offsetLeft + headerTimeSpacerWidth - scrollContainer.offsetWidth / 2 + todayColumn.offsetWidth / 2;

        // Scroll vertically to 2 hours before current time
        // Header row is sticky at 28px, content starts below it
        const currentHour = today.getHours();
        const targetHour = Math.max(0, currentHour - 2); // 2 hours before, min 0
        const headerRowHeight = 28; // sticky header height
        const scrollTargetY = headerRowHeight + (targetHour * 40); // 40px per hour

        if (smooth) {
            scrollContainer.scrollTo({ left: scrollTargetX, top: scrollTargetY, behavior: 'smooth' });
        } else {
            scrollContainer.scrollLeft = scrollTargetX;
            scrollContainer.scrollTop = scrollTargetY;
        }
    }
}

// Legacy function name for compatibility
function scrollToNow(smooth = true) {
    scrollToToday(smooth);
}

// Update week calendar display
function updateWeekCalendar() {
    const timeAxis = document.getElementById('time-axis');
    const daysContainer = document.getElementById('days-container');
    const headerDays = document.getElementById('header-days');

    if (!timeAxis || !daysContainer) return;

    // Generate time axis (no header spacer - it's in the header row now)
    timeAxis.innerHTML = '';

    const now = new Date();
    const currentHour = now.getHours();

    for (let h = 0; h < 24; h++) {
        const marker = document.createElement('div');
        marker.className = h === currentHour ? 'time-marker current-hour' : 'time-marker';
        marker.textContent = `${String(h).padStart(2, '0')}:00`;
        timeAxis.appendChild(marker);
    }

    // Generate day columns - render 21 days (3 weeks) for open-ended scrolling
    // currentWeekStart represents the "anchor" week, we show 1 week before and 1 week after
    if (headerDays) headerDays.innerHTML = '';
    daysContainer.innerHTML = '';
    const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    // Start 7 days before currentWeekStart
    const renderStart = new Date(currentWeekStart);
    renderStart.setDate(renderStart.getDate() - 7);

    for (let d = 0; d < 21; d++) {
        const dayDate = new Date(renderStart);
        dayDate.setDate(dayDate.getDate() + d);

        const isToday = dayDate.getTime() === today.getTime();
        const dayOfWeek = dayDate.getDay(); // 0=Sun, 1=Mon, ..., 6=Sat
        const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;

        // Day header cell (in sticky header row)
        if (headerDays) {
            const headerCell = document.createElement('div');
            headerCell.className = 'day-header-cell';
            if (isToday) headerCell.classList.add('today');
            if (isWeekend) headerCell.classList.add('weekend');
            headerCell.textContent = `${dayNames[dayOfWeek]} ${dayDate.getDate()}`;
            headerDays.appendChild(headerCell);
        }

        // Day column (no header - headers are in separate row)
        const column = document.createElement('div');
        column.className = 'day-column';
        if (isToday) column.classList.add('today');
        if (isWeekend) column.classList.add('weekend');
        column.dataset.date = dayDate.toISOString().split('T')[0];

        // Hour cells
        for (let h = 0; h < 24; h++) {
            const cell = document.createElement('div');
            cell.className = 'hour-cell';
            cell.dataset.hour = h;
            column.appendChild(cell);
        }

        // Day track for blocks
        const track = document.createElement('div');
        track.className = 'day-track';
        if (isScheduleMode) {
            track.classList.add('schedule-mode');
        }
        track.dataset.date = dayDate.toISOString().split('T')[0];
        column.appendChild(track);

        // Now indicator for today (no header offset - starts at top of column)
        if (isToday) {
            const nowIndicator = document.createElement('div');
            nowIndicator.className = 'now-indicator';
            nowIndicator.id = 'now-indicator';
            const nowMinutes = now.getHours() * 60 + now.getMinutes();
            const topPosition = (nowMinutes / 60) * 40; // hours * 40px per hour
            nowIndicator.style.top = `${topPosition}px`;
            column.appendChild(nowIndicator);
        }

        daysContainer.appendChild(column);
    }

    // Update visible range display after render
    updateVisibleRangeDisplay();

    // Render active blocks and scheduled blocks on the calendar
    renderWeekBlocks();
}

// Update the displayed date range based on visible columns
function updateVisibleRangeDisplay() {
    const scrollContainer = document.querySelector('.week-calendar-scroll');
    const weekDisplay = document.getElementById('week-display');
    const dayColumns = document.querySelectorAll('.day-column');

    if (!scrollContainer || !weekDisplay || dayColumns.length === 0) return;

    const scrollLeft = scrollContainer.scrollLeft;
    const containerWidth = scrollContainer.clientWidth;
    const timeAxisWidth = 50; // Width of time axis

    // Find first and last visible columns
    let firstVisible = null;
    let lastVisible = null;

    dayColumns.forEach(column => {
        const columnLeft = column.offsetLeft - timeAxisWidth;
        const columnRight = columnLeft + column.offsetWidth;

        // Column is visible if it overlaps the viewport
        if (columnRight > scrollLeft && columnLeft < scrollLeft + containerWidth) {
            if (!firstVisible) firstVisible = column;
            lastVisible = column;
        }
    });

    if (firstVisible && lastVisible) {
        const startDate = new Date(firstVisible.dataset.date);
        const endDate = new Date(lastVisible.dataset.date);
        weekDisplay.textContent = formatWeekDisplay(startDate, endDate);
    }
}
// Render active blocks on week calendar
function renderWeekBlocks() {
    const noBlocksMsg = document.getElementById('no-blocks-message');
    const now = Date.now();

    // Clear existing blocks from all day tracks
    document.querySelectorAll('.day-track').forEach(track => {
        track.innerHTML = '';
    });

    // Filter blocks within the week range
    const weekStart = currentWeekStart.getTime();
    const weekEnd = new Date(currentWeekStart);
    weekEnd.setDate(weekEnd.getDate() + 7);
    const weekEndMs = weekEnd.getTime();

    const visibleBlocks = appData.activeBlocks.filter(block =>
        block.endTime > weekStart && block.startTime < weekEndMs
    );

    // Check if there are any schedules
    const hasSchedules = appData.schedules && appData.schedules.length > 0;

    if (visibleBlocks.length === 0 && !hasSchedules) {
        noBlocksMsg?.classList.remove('hidden');
    } else {
        noBlocksMsg?.classList.add('hidden');
    }

    // Render each block
    visibleBlocks.forEach(block => {
        const blocklist = appData.blocklists.find(bl => bl.id === block.blocklistId);
        if (!blocklist) return;

        const blockStart = new Date(block.startTime);
        const blockEnd = new Date(block.endTime);
        const isExpired = block.endTime <= now;

        // Determine which day(s) the block spans
        const startDay = new Date(blockStart);
        startDay.setHours(0, 0, 0, 0);

        const endDay = new Date(blockEnd);
        endDay.setHours(0, 0, 0, 0);

        // For simplicity, render block in each day it spans
        let currentDay = new Date(startDay);

        while (currentDay <= endDay) {
            const dateStr = currentDay.toISOString().split('T')[0];
            const track = document.querySelector(`.day-track[data-date="${dateStr}"]`);

            if (track) {
                // Calculate start time for this day segment
                const dayStart = new Date(currentDay);
                dayStart.setHours(0, 0, 0, 0);
                const dayEnd = new Date(currentDay);
                dayEnd.setHours(23, 59, 59, 999);

                const segmentStart = Math.max(block.startTime, dayStart.getTime());
                const segmentEnd = Math.min(block.endTime, dayEnd.getTime());

                const startMinutes = new Date(segmentStart).getHours() * 60 + new Date(segmentStart).getMinutes();
                const endMinutes = new Date(segmentEnd).getHours() * 60 + new Date(segmentEnd).getMinutes();

                // Calculate position (40px per hour, offset by nothing since track starts at hour 0)
                const topPosition = (startMinutes / 60) * 40;
                const height = Math.max(20, ((endMinutes - startMinutes) / 60) * 40);

                const blockEl = document.createElement('div');
                blockEl.className = isExpired ? 'calendar-block expired' : 'calendar-block';
                blockEl.dataset.blockId = block.id;
                blockEl.style.top = `${topPosition}px`;
                blockEl.style.height = `${height}px`;

                if (blocklist.color) {
                    blockEl.style.background = blocklist.color;
                    blockEl.style.color = getContrastTextColor(blocklist.color);
                }

                blockEl.innerHTML = `
                    <span class="block-emoji">${blocklist.emoji || '🚫'}</span>
                    <span class="block-label">${escapeHtml(blocklist.name)}</span>
                    <span class="block-time">${formatTime(new Date(segmentStart))} - ${formatTime(new Date(segmentEnd))}</span>
                `;

                // Add click handler for override (only for running blocks)
                if (!isExpired) {
                    blockEl.addEventListener('click', (e) => {
                        e.stopPropagation();
                        openOverrideModal(block.id);
                    });
                }

                track.appendChild(blockEl);
            }

            // Move to next day
            currentDay.setDate(currentDay.getDate() + 1);
        }
    });

    // Render scheduled blocks
    renderScheduledCalendarBlocks();

    // Layout overlapping blocks side-by-side (Apple Calendar style)
    layoutOverlappingBlocks();
}

// Layout overlapping blocks side-by-side within each day track (Apple Calendar style)
function layoutOverlappingBlocks() {
    document.querySelectorAll('.day-track').forEach(track => {
        const blocks = Array.from(track.querySelectorAll('.calendar-block'));
        if (blocks.length <= 1) return;

        // Get block positions and group identifier (scheduleId or blockId)
        const blockData = blocks.map(block => {
            const top = parseFloat(block.style.top) || 0;
            const height = parseFloat(block.style.height) || 20;
            // Use scheduleId if available, fall back to blockId
            const groupId = block.dataset.scheduleId || block.dataset.blockId || null;
            return {
                element: block,
                top: top,
                bottom: top + height,
                groupId: groupId,
                column: 0,
                totalColumns: 1
            };
        });

        // Sort by top position, then by height (taller blocks first)
        blockData.sort((a, b) => a.top - b.top || b.bottom - a.bottom);

        // First pass: assign columns to groups (blocks from same schedule get same column)
        const groupColumns = new Map(); // groupId -> column

        for (let i = 0; i < blockData.length; i++) {
            const current = blockData[i];

            // If this block's group already has a column, use it
            if (current.groupId && groupColumns.has(current.groupId)) {
                current.column = groupColumns.get(current.groupId);
                continue;
            }

            // Find all blocks that overlap with current (considering the entire group)
            const overlappingGroups = new Set();
            for (let j = 0; j < blockData.length; j++) {
                const other = blockData[j];
                // Check if they overlap
                if (!(current.bottom <= other.top || current.top >= other.bottom)) {
                    if (other.groupId !== current.groupId) {
                        overlappingGroups.add(other.groupId);
                    }
                }
            }

            // Find columns used by overlapping groups
            const usedColumns = new Set();
            overlappingGroups.forEach(gid => {
                if (groupColumns.has(gid)) {
                    usedColumns.add(groupColumns.get(gid));
                }
            });

            // Assign the first available column
            let col = 1;
            while (usedColumns.has(col)) col++;
            current.column = col;
            if (current.groupId) {
                groupColumns.set(current.groupId, col);
            }
        }

        // Second pass: calculate totalColumns for overlapping sets
        for (let i = 0; i < blockData.length; i++) {
            const current = blockData[i];
            let maxCol = current.column;

            for (let j = 0; j < blockData.length; j++) {
                const other = blockData[j];
                if (!(current.bottom <= other.top || current.top >= other.bottom)) {
                    maxCol = Math.max(maxCol, other.column);
                }
            }
            current.totalColumns = maxCol;
        }

        // Apply positioning
        blockData.forEach(data => {
            if (data.totalColumns > 1) {
                const widthPercent = 100 / data.totalColumns;
                const leftPercent = (data.column - 1) * widthPercent;
                data.element.style.left = `calc(${leftPercent}% + 2px)`;
                data.element.style.width = `calc(${widthPercent}% - 4px)`;
                data.element.style.right = 'auto';
            }
        });
    });
}

// Render scheduled blocks on the calendar (from saved schedules)
function renderScheduledCalendarBlocks() {
    console.log('renderScheduledCalendarBlocks called, schedules:', appData.schedules);
    if (!appData.schedules || appData.schedules.length === 0) return;

    const now = new Date();
    const today = now.getDay(); // 0=Sun, 1=Mon, etc.
    const todayIndex = today === 0 ? 6 : today - 1; // Convert to 0=Mon format

    // Generate all 21 visible days (7 before anchor week, anchor week, 7 after anchor week)
    // This matches the calendar's visible range
    const renderStart = new Date(currentWeekStart);
    renderStart.setDate(renderStart.getDate() - 7);

    const allVisibleDays = [];
    for (let i = 0; i < 21; i++) {
        const day = new Date(renderStart);
        day.setDate(day.getDate() + i);
        allVisibleDays.push({
            date: day,
            dateStr: day.toISOString().split('T')[0],
            dayIndex: (day.getDay() === 0 ? 6 : day.getDay() - 1) // Convert to 0=Mon format
        });
    }

    appData.schedules.forEach(schedule => {
        const blocklist = appData.blocklists.find(bl => bl.id === schedule.blocklistId);
        if (!blocklist) return;

        // Skip if blocklist has "always show in schedule" unchecked and isn't currently selected
        if (blocklist.alwaysShowInSchedule === false && schedule.blocklistId !== selectedBlocklistId) {
            return;
        }

        // Check if schedule has expired (for date-limited schedules)
        if (schedule.repeatType === 'date' && schedule.repeatDate) {
            const endDate = new Date(schedule.repeatDate);
            if (now > endDate) return;
        }

        // Render each segment on its applicable days
        schedule.segments.forEach((segment, segmentIdx) => {
            const segmentDays = segment.days || [];

            allVisibleDays.forEach((weekDay, weekDayIdx) => {
                if (!segmentDays.includes(weekDay.dayIndex)) return;

                const track = document.querySelector(`.day-track[data-date="${weekDay.dateStr}"]`);
                if (!track) return;

                // Calculate position
                const startMinutes = segment.startHour * 60 + segment.startMinute;
                const endMinutes = segment.endHour * 60 + segment.endMinute;

                // Check if this is an overnight block (end time is before start time)
                const isOvernight = endMinutes <= startMinutes;

                if (isOvernight) {
                    // Render first part: from start until midnight (end of day)
                    const topPosition1 = (startMinutes / 60) * 40;
                    const height1 = ((1440 - startMinutes) / 60) * 40; // 1440 = 24 * 60 (midnight)

                    const blockEl1 = document.createElement('div');
                    blockEl1.className = 'calendar-block scheduled';
                    blockEl1.dataset.scheduleId = schedule.id;
                    blockEl1.dataset.segmentIndex = segmentIdx;
                    blockEl1.dataset.day = weekDay.dayIndex;
                    blockEl1.style.top = `${topPosition1}px`;
                    blockEl1.style.height = `${height1}px`;

                    if (blocklist.color) {
                        blockEl1.style.background = blocklist.color;
                        blockEl1.style.opacity = '0.7';
                        blockEl1.style.color = getContrastTextColor(blocklist.color);
                    }

                    const startTimeStr = `${String(segment.startHour).padStart(2, '0')}:${String(segment.startMinute).padStart(2, '0')}`;
                    const endTimeStr = `${String(segment.endHour).padStart(2, '0')}:${String(segment.endMinute).padStart(2, '0')}`;

                    blockEl1.innerHTML = `
                        <span class="block-emoji">${blocklist.emoji || '🚫'}</span>
                        <span class="block-label">${escapeHtml(blocklist.name)}</span>
                        <span class="block-time">${startTimeStr} - ${endTimeStr}</span>
                        <span class="schedule-icon"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="18" x="3" y="4" rx="2" ry="2"/><path d="M16 2v4"/><path d="M8 2v4"/><path d="M3 10h18"/></svg></span>
                    `;

                    blockEl1.addEventListener('click', (e) => {
                        e.stopPropagation();
                        openScheduledBlockOverrideModal(schedule, segmentIdx, weekDay.dayIndex);
                    });

                    track.appendChild(blockEl1);

                    // Render second part: from midnight until end time on the next day
                    const nextDay = allVisibleDays[weekDayIdx + 1];
                    if (nextDay) {
                        const nextTrack = document.querySelector(`.day-track[data-date="${nextDay.dateStr}"]`);
                        if (nextTrack) {
                            const topPosition2 = 0;
                            const height2 = Math.max(20, (endMinutes / 60) * 40);

                            const blockEl2 = document.createElement('div');
                            blockEl2.className = 'calendar-block scheduled overnight-continuation';
                            blockEl2.dataset.scheduleId = schedule.id;
                            blockEl2.dataset.segmentIndex = segmentIdx;
                            blockEl2.dataset.day = nextDay.dayIndex;
                            blockEl2.style.top = `${topPosition2}px`;
                            blockEl2.style.height = `${height2}px`;

                            if (blocklist.color) {
                                blockEl2.style.background = blocklist.color;
                                blockEl2.style.opacity = '0.7';
                                blockEl2.style.color = getContrastTextColor(blocklist.color);
                            }

                            blockEl2.innerHTML = `
                                <span class="block-emoji">${blocklist.emoji || '🚫'}</span>
                                <span class="block-label">${escapeHtml(blocklist.name)}</span>
                                <span class="block-time">${startTimeStr} - ${endTimeStr}</span>
                                <span class="schedule-icon"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="18" x="3" y="4" rx="2" ry="2"/><path d="M16 2v4"/><path d="M8 2v4"/><path d="M3 10h18"/></svg></span>
                            `;

                            blockEl2.addEventListener('click', (e) => {
                                e.stopPropagation();
                                openScheduledBlockOverrideModal(schedule, segmentIdx, weekDay.dayIndex);
                            });

                            nextTrack.appendChild(blockEl2);
                        }
                    }
                } else {
                    // Normal same-day block
                    const topPosition = (startMinutes / 60) * 40;
                    const height = Math.max(20, ((endMinutes - startMinutes) / 60) * 40);

                    const blockEl = document.createElement('div');
                    blockEl.className = 'calendar-block scheduled';
                    blockEl.dataset.scheduleId = schedule.id;
                    blockEl.dataset.segmentIndex = segmentIdx;
                    blockEl.dataset.day = weekDay.dayIndex;
                    blockEl.style.top = `${topPosition}px`;
                    blockEl.style.height = `${height}px`;

                    if (blocklist.color) {
                        blockEl.style.background = blocklist.color;
                        blockEl.style.opacity = '0.7';
                        blockEl.style.color = getContrastTextColor(blocklist.color);
                    }

                    const startTimeStr = `${String(segment.startHour).padStart(2, '0')}:${String(segment.startMinute).padStart(2, '0')}`;
                    const endTimeStr = `${String(segment.endHour).padStart(2, '0')}:${String(segment.endMinute).padStart(2, '0')}`;

                    blockEl.innerHTML = `
                        <span class="block-emoji">${blocklist.emoji || '🚫'}</span>
                        <span class="block-label">${escapeHtml(blocklist.name)}</span>
                        <span class="block-time">${startTimeStr} - ${endTimeStr}</span>
                        <span class="schedule-icon"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="18" x="3" y="4" rx="2" ry="2"/><path d="M16 2v4"/><path d="M8 2v4"/><path d="M3 10h18"/></svg></span>
                    `;

                    blockEl.addEventListener('click', (e) => {
                        e.stopPropagation();
                        openScheduledBlockOverrideModal(schedule, segmentIdx, weekDay.dayIndex);
                    });

                    track.appendChild(blockEl);
                }
            });
        });
    });
}

// Render blocklist selector dropdown
function renderBlocklistSelector() {
    const select = document.getElementById('blocklist-select');
    const currentValue = select.value;
    const activeIds = appData.activeBlocks.map(b => b.blocklistId);

    const newHTML = `
    <option value="">Select a blocklist...</option>
    ${appData.blocklists.map(bl => {
        const isActive = activeIds.includes(bl.id);
        const disabledAttr = isActive ? 'disabled' : '';
        const activeLabel = isActive ? ' (Running)' : '';
        return `<option value="${bl.id}" ${disabledAttr}>${escapeHtml(bl.name)}${activeLabel}</option>`;
    }).join('')}
  `;

    // Only update if changed to prevent closing dropdown
    // Normalize logic to ignore potential minor diffs if logic is sound, but direct string compare is fine
    if (select.innerHTML !== newHTML) {
        select.innerHTML = newHTML;
        select.value = currentValue;
    }
}

// Render blocklists
function renderBlocklists() {
    const container = document.getElementById('blocklists-container');

    if (appData.blocklists.length === 0) {
        container.innerHTML = `
      <div class="no-active-blocks clickable" id="empty-blocklists-cta" style="cursor: pointer;">
        <p>No blocklists yet</p>
        <p class="subtle">Click here to create one</p>
      </div>
    `;
        document.getElementById('empty-blocklists-cta').addEventListener('click', () => {
            openBlocklistModal();
        });
        return;
    }

    container.innerHTML = appData.blocklists.map(bl => {
        // Build detailed meta text
        const websiteCount = bl.websites?.length || 0;
        const appCount = bl.apps?.length || 0;
        const showDetails = bl.showItemDetails !== false; // Default to true
        let metaParts = [];

        if (websiteCount > 0) {
            if (showDetails) {
                const displaySites = bl.websites.map(cleanUrlForDisplay);
                if (websiteCount <= 2) {
                    metaParts.push(`${websiteCount} ${websiteCount === 1 ? 'website' : 'websites'} (${displaySites.join(', ')})`);
                } else {
                    metaParts.push(`${websiteCount} websites (${displaySites.slice(0, 2).join(', ')}, ...)`);
                }
            } else {
                metaParts.push(`${websiteCount} ${websiteCount === 1 ? 'website' : 'websites'}`);
            }
        }

        if (appCount > 0) {
            if (showDetails) {
                if (appCount <= 2) {
                    metaParts.push(`${appCount} ${appCount === 1 ? 'app' : 'apps'} (${bl.apps.join(', ')})`);
                } else {
                    metaParts.push(`${appCount} apps (${bl.apps.slice(0, 2).join(', ')}, ...)`);
                }
            } else {
                metaParts.push(`${appCount} ${appCount === 1 ? 'app' : 'apps'}`);
            }
        }

        const metaText = metaParts.length > 0 ? metaParts.join(' and ') : 'No items';

        // Get color for left border
        // Get color for left border
        const borderColor = bl.color || 'linear-gradient(135deg, #4a00e0 0%, #8e2de2 100%)';

        // Check if this blocklist has an active block
        const now = Date.now();
        const activeBlock = appData.activeBlocks.find(b => b.blocklistId === bl.id && b.startTime <= now && b.endTime > now);
        const isActive = !!activeBlock;

        // Check if this blocklist has a schedule
        const hasSchedule = appData.schedules && appData.schedules.some(s => s.blocklistId === bl.id);

        const activeClass = isActive ? ' blocklist-card-active' : (hasSchedule ? ' blocklist-card-scheduled' : '');

        // Calculate badges - show BOTH if applicable
        let oneOffBadge = '';
        let scheduleBadge = '';

        // One-off block badge (green with hourglass)
        if (isActive && activeBlock) {
            const remaining = activeBlock.endTime - now;
            const mins = Math.ceil(remaining / 60000);
            const timeText = mins >= 60 ? `${Math.floor(mins / 60)}h ${mins % 60}m` : `${mins}m`;
            // Hourglass icon
            oneOffBadge = `<span class="active-badge"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 22h14"/><path d="M5 2h14"/><path d="M17 22v-4.172a2 2 0 0 0-.586-1.414L12 12l-4.414 4.414A2 2 0 0 0 7 17.828V22"/><path d="M7 2v4.172a2 2 0 0 0 .586 1.414L12 12l4.414-4.414A2 2 0 0 0 17 6.172V2"/></svg> ${timeText} left</span>`;
        }

        // Schedule badge (blue with calendar-sync)
        if (hasSchedule) {
            const schedule = appData.schedules.find(s => s.blocklistId === bl.id);
            let scheduleTimeText = '';
            if (schedule && schedule.segments) {
                // Check if any segment is currently active
                const nowDate = new Date();
                const currentDay = nowDate.getDay() === 0 ? 6 : nowDate.getDay() - 1; // Mon=0
                const currentMins = nowDate.getHours() * 60 + nowDate.getMinutes();

                // Find active segment (handling cross-midnight segments)
                const activeSegment = schedule.segments.find(seg => {
                    const startMins = seg.startHour * 60 + seg.startMinute;
                    const endMins = seg.endHour * 60 + seg.endMinute;

                    if (endMins > startMins) {
                        // Same-day segment (e.g., 09:00 - 17:00)
                        return seg.days.includes(currentDay) &&
                            currentMins >= startMins &&
                            currentMins < endMins;
                    } else {
                        // Cross-midnight segment (e.g., 22:00 - 04:00)
                        const yesterdayDay = currentDay === 0 ? 6 : currentDay - 1;
                        const inEveningPortion = seg.days.includes(currentDay) && currentMins >= startMins;
                        const inMorningPortion = seg.days.includes(yesterdayDay) && currentMins < endMins;
                        return inEveningPortion || inMorningPortion;
                    }
                });

                if (activeSegment) {
                    // Currently blocking - show time left
                    const startMins = activeSegment.startHour * 60 + activeSegment.startMinute;
                    const endMins = activeSegment.endHour * 60 + activeSegment.endMinute;
                    let minsLeft;

                    if (endMins > startMins) {
                        // Same-day segment
                        minsLeft = endMins - currentMins;
                    } else {
                        // Cross-midnight segment
                        if (currentMins >= startMins) {
                            // In evening portion: time until midnight + morning end
                            minsLeft = (24 * 60 - currentMins) + endMins;
                        } else {
                            // In morning portion: time until end
                            minsLeft = endMins - currentMins;
                        }
                    }
                    scheduleTimeText = minsLeft >= 60 ? `${Math.floor(minsLeft / 60)}h ${minsLeft % 60}m left` : `${minsLeft}m left`;
                } else {
                    // Find next upcoming segment
                    let nextStart = null;
                    for (let dayOffset = 0; dayOffset < 7; dayOffset++) {
                        const checkDay = (currentDay + dayOffset) % 7;
                        const segsForDay = schedule.segments.filter(seg => seg.days.includes(checkDay))
                            .sort((a, b) => (a.startHour * 60 + a.startMinute) - (b.startHour * 60 + b.startMinute));

                        for (const seg of segsForDay) {
                            const segStartMins = seg.startHour * 60 + seg.startMinute;
                            if (dayOffset === 0 && segStartMins <= currentMins) continue; // Already passed today

                            // Found next segment
                            const minsUntil = dayOffset === 0
                                ? segStartMins - currentMins
                                : (dayOffset * 24 * 60) + segStartMins - currentMins + (24 * 60 - currentMins) - (24 * 60 - segStartMins);

                            if (minsUntil < 60) {
                                scheduleTimeText = `in ${minsUntil}m`;
                            } else if (minsUntil < 24 * 60) {
                                scheduleTimeText = `in ${Math.floor(minsUntil / 60)}h`;
                            } else {
                                const days = Math.floor(minsUntil / (24 * 60));
                                scheduleTimeText = `in ${days}d`;
                            }
                            nextStart = true;
                            break;
                        }
                        if (nextStart) break;
                    }
                    if (!scheduleTimeText) scheduleTimeText = 'scheduled';
                }
            }
            // Calendar icon for scheduled blocklists
            scheduleBadge = `<span class="schedule-badge"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="18" x="3" y="4" rx="2" ry="2"/><path d="M16 2v4"/><path d="M8 2v4"/><path d="M3 10h18"/></svg> ${scheduleTimeText}</span>`;
        }

        const activeBadge = oneOffBadge + scheduleBadge;

        // Check if this blocklist is selected
        const isSelected = bl.id === selectedBlocklistId;
        const selectedClass = isSelected ? ' selected' : '';
        const selectedStyle = isSelected ? `style="box-shadow: 0 0 0 2px ${bl.color || '#667eea'}, 0 4px 8px rgba(0, 0, 0, 0.1);"` : '';

        // Dim if something is selected but this one isn't
        const isDimmed = selectedBlocklistId && !isSelected;
        const dimmedClass = isDimmed ? ' dimmed' : '';

        return `
      <div class="blocklist-card${activeClass}${selectedClass}${dimmedClass}" data-id="${bl.id}" data-active="${isActive}" ${selectedStyle} style="touch-action: none;">
        <div class="blocklist-stripe" style="background: ${borderColor}"></div>
        <div class="blocklist-info">
          <div class="blocklist-name"><span class="blocklist-emoji">${bl.emoji || '🚫'}</span>${escapeHtml(bl.name)}${activeBadge}</div>
          <div class="blocklist-meta">${escapeHtml(metaText)}</div>
        </div>
        <div class="blocklist-actions">
          <button class="blocklist-action-btn delete" title="Delete">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <polyline points="3 6 5 6 21 6"></polyline>
              <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
            </svg>
          </button>
          <button class="blocklist-action-btn edit-btn" title="Edit">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path>
              <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path>
            </svg>
          </button>
        </div>
      </div>
    `;
    }).join('');

    // Add event listeners
    container.querySelectorAll('.blocklist-card').forEach(card => {
        const id = card.dataset.id;
        const isActive = card.dataset.active === 'true';

        // Click card to select it in the dropdown
        card.addEventListener('click', () => {
            const dropdown = document.getElementById('blocklist-select');
            dropdown.value = id;
            handleBlocklistSelect({ target: dropdown });
        });

        card.querySelector('.edit-btn').addEventListener('click', (e) => {
            e.stopPropagation();
            const blocklist = appData.blocklists.find(bl => bl.id === id);
            openBlocklistModal(blocklist);
        });

        card.querySelector('.delete').addEventListener('click', (e) => {
            e.stopPropagation();
            deleteBlocklist(id);
        });

        // Drag and drop using mouse events on document
        card.addEventListener('mousedown', (e) => {
            // Don't start drag if clicking on buttons
            if (e.target.closest('.edit-btn') || e.target.closest('.delete')) return;
            if (e.target.closest('.blocklist-actions')) return;
            if (e.button !== 0) return; // Only left click

            e.preventDefault(); // Prevent text selection

            const startY = e.clientY;
            let isDragging = false;
            const container = document.getElementById('blocklists-container');


            const onMouseMove = (moveEvent) => {
                // Only start dragging after moving 5px
                if (!isDragging && Math.abs(moveEvent.clientY - startY) > 5) {
                    isDragging = true;
                    card.classList.add('dragging');
                }

                if (!isDragging) return;

                const siblings = [...container.querySelectorAll('.blocklist-card:not(.dragging)')];
                const nextSibling = siblings.find(sibling => {
                    const rect = sibling.getBoundingClientRect();
                    return moveEvent.clientY < rect.top + rect.height / 2;
                });


                if (nextSibling) {
                    container.insertBefore(card, nextSibling);
                } else {
                    container.appendChild(card);
                }
            };

            const onMouseUp = () => {
                document.removeEventListener('mousemove', onMouseMove);
                document.removeEventListener('mouseup', onMouseUp);
                card.classList.remove('dragging');

                if (isDragging) {
                    saveBlocklistOrderFromDOM();
                }
            };

            document.addEventListener('mousemove', onMouseMove);
            document.addEventListener('mouseup', onMouseUp);
        });
    });
}

// Save blocklist order based on DOM position
function saveBlocklistOrderFromDOM() {
    const container = document.getElementById('blocklists-container');
    if (!container) return;

    const cardElements = Array.from(container.querySelectorAll('.blocklist-card'));
    const newOrder = cardElements.map(card => card.dataset.id);

    // Reorder appData.blocklists to match
    const reorderedBlocklists = [];
    newOrder.forEach(id => {
        const blocklist = appData.blocklists.find(bl => bl.id === id);
        if (blocklist) {
            reorderedBlocklists.push(blocklist);
        }
    });

    // Add any blocklists that weren't in the DOM
    appData.blocklists.forEach(bl => {
        if (!reorderedBlocklists.find(r => r.id === bl.id)) {
            reorderedBlocklists.push(bl);
        }
    });

    appData.blocklists = reorderedBlocklists;
    saveData();
}

// Start interval to update remaining time
function startTickInterval() {
    // Track which blocks have been activated (to avoid repeated password prompts)
    // Initialize activatedBlockIds with already-active blocks at startup
    activatedBlockIds = new Set(
        appData.activeBlocks
            .filter(b => b.startTime <= Date.now())
            .map(b => b.id)
    );

    // Initialize app blocking immediately at startup
    // This ensures any active blocks or schedules are enforced right away
    updateBlockedApps();

    setInterval(async () => {
        const now = Date.now();

        // Check for future blocks that have now become active
        const newlyActiveBlocks = appData.activeBlocks.filter(
            block => block.startTime <= now && !activatedBlockIds.has(block.id)
        );

        if (newlyActiveBlocks.length > 0) {
            // Mark as activated
            newlyActiveBlocks.forEach(b => activatedBlockIds.add(b.id));
            // Update hosts to apply the blocking rules
            await updateHostsFile();
            render();
        }

        // Check for schedule segment transitions (every minute is fine since schedules are minute-granular)
        // updateHostsFile already handles checking which schedules are currently active
        // We call it periodically to catch schedule segments starting/ending
        if (appData.schedules && appData.schedules.length > 0) {
            await updateHostsFile();
            // Also update blocked apps when schedules activate/deactivate
            await updateBlockedApps();

            // Check for expired non-repeating schedules and auto-stop them
            const expiredScheduleIds = [];
            const nowDate = new Date(now);

            for (const schedule of appData.schedules) {
                // Only check non-repeating schedules (repeatType === 'no' or undefined)
                if (schedule.repeatType === 'forever') continue;

                // For date-limited schedules, check if past the repeat date
                if (schedule.repeatType === 'date' && schedule.repeatDate) {
                    const endDate = new Date(schedule.repeatDate);
                    endDate.setHours(23, 59, 59, 999); // End of day
                    if (nowDate > endDate) {
                        expiredScheduleIds.push(schedule.id);
                        console.log('Schedule expired (past repeat date):', schedule.id);
                    }
                    continue;
                }

                // For non-repeating schedules (repeatType === 'no' or undefined)
                // Calculate when each segment was supposed to occur based on createdAt
                const createdAt = new Date(schedule.createdAt);
                const createdDayOfWeek = createdAt.getDay() === 0 ? 6 : createdAt.getDay() - 1; // Convert to Mon=0 format

                let allSegmentsExpired = true;

                for (const segment of schedule.segments) {
                    for (const segmentDay of segment.days) {
                        // Calculate the actual date this segment occurs on
                        // It should be the first occurrence of this day on or after createdAt
                        let daysUntilSegment = segmentDay - createdDayOfWeek;
                        if (daysUntilSegment < 0) daysUntilSegment += 7;

                        const segmentDate = new Date(createdAt);
                        segmentDate.setDate(segmentDate.getDate() + daysUntilSegment);
                        segmentDate.setHours(segment.endHour, segment.endMinute, 0, 0);

                        // If this segment's end time is still in the future, the schedule is not expired
                        if (segmentDate > nowDate) {
                            allSegmentsExpired = false;
                            break;
                        }
                    }
                    if (!allSegmentsExpired) break;
                }

                if (allSegmentsExpired) {
                    expiredScheduleIds.push(schedule.id);
                    console.log('Non-repeating schedule expired (all segments passed):', schedule.id);
                }
            }

            // Remove expired schedules
            if (expiredScheduleIds.length > 0) {
                const previousScheduleCount = appData.schedules.length;
                appData.schedules = appData.schedules.filter(s => !expiredScheduleIds.includes(s.id));

                if (appData.schedules.length < previousScheduleCount) {
                    console.log('Auto-stopped expired schedule(s):', expiredScheduleIds);
                    activeScheduleSegmentCount = 0;
                    await saveData();
                    // Update blocked apps after schedule expiration
                    await updateBlockedApps();
                    render();
                }
            }
        }

        // Check for expired blocks
        const previousCount = appData.activeBlocks.length;
        appData.activeBlocks = appData.activeBlocks.filter(block => block.endTime > now);

        // Clean up activated set
        activatedBlockIds = new Set(
            [...activatedBlockIds].filter(id =>
                appData.activeBlocks.some(b => b.id === id)
            )
        );

        // Only re-render if blocks actually expired
        if (appData.activeBlocks.length < previousCount) {
            saveData();
            // Don't update hosts in tick - it causes password prompts
            // Just re-render the UI
            render();

            // Update blocked apps (will stop watcher if no active blocks or schedules)
            // This ensures schedules are still respected even if one-off blocks expired
            await updateBlockedApps();
        }

        // Update remaining times in UI
        document.querySelectorAll('.entry-remaining').forEach((el, idx) => {
            const block = appData.activeBlocks[idx];
            if (block) {
                const remaining = Math.max(0, Math.ceil((block.endTime - now) / 60000));
                el.textContent = `${formatDuration(remaining)} remaining`;
            }
        });

        // Auto-update end time if user hasn't manually edited it
        if (selectedBlocklistId && !userEditedEndTime) {
            const newEndTime = new Date(now + targetDurationMinutes * 60 * 1000);
            selectedEndHour = newEndTime.getHours();
            selectedEndMinute = newEndTime.getMinutes();
            updateTimeDisplay();
            // Don't call handleTimeChange here to avoid circular updates
        }
    }, 1000);
}

// Utility functions
function generateId() {
    return Date.now().toString(36) + Math.random().toString(36).substr(2);
}

function formatTime(date) {
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function formatDuration(minutes) {
    if (minutes < 60) {
        return `${minutes} min${minutes !== 1 ? 's' : ''}`;
    }
    const hours = Math.floor(minutes / 60);
    const mins = minutes % 60;
    if (mins === 0) {
        return `${hours} hour${hours !== 1 ? 's' : ''}`;
    }
    return `${hours}h ${mins}m`;
}

function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

// Clean up URL for display (remove protocol, www, trailing slash)
function cleanUrlForDisplay(url) {
    return url
        .replace(/^https?:\/\//, '')  // Remove http:// or https://
        .replace(/^www\./, '')         // Remove www.
        .replace(/\/$/, '');           // Remove trailing slash
}

// Get contrasting text color (black or white) based on background color
function getContrastTextColor(backgroundColor) {
    if (!backgroundColor) return '#ffffff';

    // Parse color - handle hex, rgb, rgba, and named colors
    let r, g, b;

    if (backgroundColor.startsWith('#')) {
        // Hex color
        const hex = backgroundColor.slice(1);
        if (hex.length === 3) {
            r = parseInt(hex[0] + hex[0], 16);
            g = parseInt(hex[1] + hex[1], 16);
            b = parseInt(hex[2] + hex[2], 16);
        } else if (hex.length >= 6) {
            r = parseInt(hex.slice(0, 2), 16);
            g = parseInt(hex.slice(2, 4), 16);
            b = parseInt(hex.slice(4, 6), 16);
        }
    } else if (backgroundColor.startsWith('rgb')) {
        // RGB or RGBA
        const match = backgroundColor.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
        if (match) {
            r = parseInt(match[1]);
            g = parseInt(match[2]);
            b = parseInt(match[3]);
        }
    }

    // If we couldn't parse, default to white text
    if (r === undefined || g === undefined || b === undefined) {
        return '#ffffff';
    }

    // Calculate relative luminance using WCAG formula
    const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;

    // Return black for light backgrounds, white for dark backgrounds
    return luminance > 0.5 ? '#000000' : '#ffffff';
}

// Theme Handling
function setupTheme() {
    // Apply initial theme from saved settings
    applyTheme();

    // Setup settings modal
    const settingsBtn = document.getElementById('settings-btn');
    const settingsModal = document.getElementById('settings-modal');
    const closeSettingsBtn = document.getElementById('close-settings-btn');
    const themeSelect = document.getElementById('theme-select');
    const openDebugWindowBtn = document.getElementById('open-debug-window-btn');
    
    // Debug window button handler
    if (openDebugWindowBtn) {
        openDebugWindowBtn.addEventListener('click', async () => {
            try {
                await invoke('open_debug_window');
            } catch (error) {
                console.error('Failed to open debug window:', error);
                alert('Failed to open debug window: ' + error);
            }
        });
    }

    if (settingsBtn && settingsModal) {
        settingsBtn.addEventListener('click', async () => {
            settingsModal.classList.remove('hidden');
            // Set current theme selection
            if (themeSelect) {
                const currentTheme = appData.settings?.themeMode || 'system';
                themeSelect.value = currentTheme;
            }

            // Fetch and display version info
            const currentVersionEl = document.getElementById('current-app-version');
            const latestVersionEl = document.getElementById('latest-app-version');

            let currentVersion = null;

            if (currentVersionEl) {
                try {
                    currentVersion = await tauriAPI.getAppVersion();
                    currentVersionEl.textContent = `Your version: ${currentVersion || 'Unknown'}`;
                } catch (e) {
                    console.error('[Version] Error fetching current version:', e);
                    currentVersionEl.textContent = 'Your version: Unknown';
                }
            }

            if (latestVersionEl) {
                // Hide by default - only show if there's an update available
                latestVersionEl.style.display = 'none';

                try {
                    const response = await fetch('https://ulyngs.github.io/redd-block/latest-versions.json');
                    const versions = await response.json();
                    // Detect platform
                    const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0;
                    const platform = isMac ? 'macos' : 'windows';
                    const latestVersion = versions[platform];

                    // Only show if latest version is higher than current version
                    if (latestVersion && currentVersion && isVersionHigher(latestVersion, currentVersion)) {
                        latestVersionEl.textContent = `Latest version: ${latestVersion}`;
                        latestVersionEl.style.display = 'block';
                    }
                } catch (e) {
                    // Silently fail if offline - don't show anything
                    console.log('[Version] Could not check for updates (offline or error):', e.message);
                }
            }
        });
    }

    if (closeSettingsBtn && settingsModal) {
        closeSettingsBtn.addEventListener('click', () => {
            settingsModal.classList.add('hidden');
        });
    }

    // Close modal when clicking outside
    if (settingsModal) {
        settingsModal.addEventListener('click', (e) => {
            if (e.target === settingsModal) {
                settingsModal.classList.add('hidden');
            }
        });
    }

    // Theme selection change
    if (themeSelect) {
        themeSelect.addEventListener('change', (e) => {
            if (!appData.settings) appData.settings = {};
            appData.settings.themeMode = e.target.value;

            // Update legacy darkMode for backwards compatibility
            if (e.target.value === 'dark') {
                appData.settings.darkMode = true;
            } else if (e.target.value === 'light') {
                appData.settings.darkMode = false;
            } else {
                // Auto/system mode - use system preference
                delete appData.settings.darkMode;
            }

            applyTheme();
            saveData();
        });
    }

    // Listen for system theme changes when in auto mode
    if (window.matchMedia) {
        window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
            if (appData.settings?.themeMode === 'system' || !appData.settings?.themeMode) {
                applyTheme();
            }
        });
    }
}

function applyTheme() {
    const body = document.body;
    const themeMode = appData.settings?.themeMode || 'system';

    let isDark;
    if (themeMode === 'dark') {
        isDark = true;
    } else if (themeMode === 'light') {
        isDark = false;
    } else {
        // Auto/system mode - detect system preference
        isDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
    }

    if (isDark) {
        body.classList.add('dark-mode');
    } else {
        body.classList.remove('dark-mode');
    }
}

// Setup Helper Settings in the settings modal
function setupHelperSettings() {
    const statusIndicator = document.getElementById('helper-status-indicator');
    const keepBlockingToggle = document.getElementById('keep-blocking-toggle');
    const removeHelperNowBtn = document.getElementById('remove-helper-now-btn');

    // Initialize toggle from saved settings
    // When checked (default): blocks continue running after uninstall until complete
    // When unchecked: helper immediately cleans up when app is uninstalled
    if (keepBlockingToggle) {
        const keepBlocking = appData.settings?.keepBlockingOnUninstall !== false; // default true
        keepBlockingToggle.checked = keepBlocking;

        keepBlockingToggle.addEventListener('change', (e) => {
            if (!appData.settings) appData.settings = {};
            appData.settings.keepBlockingOnUninstall = e.target.checked;
            saveData();
        });
    }

    // Update helper status when settings modal opens
    const settingsBtn = document.getElementById('settings-btn');
    if (settingsBtn) {
        settingsBtn.addEventListener('click', updateHelperStatusIndicator);
    }

    // Remove Helper Now button - use named function to avoid duplicates
    if (removeHelperNowBtn && !removeHelperNowBtn._helperRemoveListenerAdded) {
        removeHelperNowBtn._helperRemoveListenerAdded = true;

        removeHelperNowBtn.addEventListener('click', async () => {
            // Guard against double execution using global flag
            if (window._isRemovingHelper) {
                console.log('Helper removal already in progress (global flag), ignoring click');
                return;
            }
            window._isRemovingHelper = true;
            console.log('Remove helper clicked, setting global guard flag');

            try {
                // Check if there are active blocks
                const hasActiveBlocks = hasAnyActiveBlocks();
                console.log('Has active blocks:', hasActiveBlocks);

                let confirmed = false;
                if (hasActiveBlocks) {
                    // Need challenge first - show override modal
                    confirmed = await showRemoveHelperChallenge();
                } else {
                    // No active blocks - use Tauri's async dialog (native confirm() doesn't block in webview)
                    confirmed = await ask('Are you sure you want to remove the helper service? Website blocking will stop working until you reinstall it.', {
                        title: 'Remove Helper?',
                        kind: 'warning'
                    });
                }

                console.log('User confirmed:', confirmed);
                if (!confirmed) {
                    window._isRemovingHelper = false;
                    return;
                }

                // Proceed with removal
                removeHelperNowBtn.disabled = true;
                removeHelperNowBtn.innerHTML = '<span class="btn-spinner"></span>Removing...';

                const result = await tauriAPI.uninstallHelper();
                if (result.success) {
                    helperAvailable = false;
                    // Immediately update UI - don't wait for async check
                    const statusIndicator = document.getElementById('helper-status-indicator');
                    if (statusIndicator) {
                        statusIndicator.classList.remove('running');
                        statusIndicator.classList.add('stopped');
                        const statusText = statusIndicator.querySelector('.status-text');
                        if (statusText) statusText.textContent = 'Not installed';
                    }
                    // Hide the Remove Helper Now button
                    removeHelperNowBtn.style.display = 'none';
                    alert('Helper service removed successfully.');
                } else {
                    alert('Failed to remove helper: ' + (result.error || 'Unknown error'));
                }
            } catch (e) {
                console.error('Error removing helper:', e);
                alert('Error removing helper: ' + e.message);
            } finally {
                window._isRemovingHelper = false;
                console.log('Remove helper complete, cleared global guard flag');
                removeHelperNowBtn.disabled = false;
                removeHelperNowBtn.innerHTML = `
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        <path d="M3 6h18"></path>
                        <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"></path>
                        <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"></path>
                    </svg>
                    <span>Uninstall Helper</span>
                `;
            }
        });
    }
}

// Update helper status indicator in settings modal
async function updateHelperStatusIndicator() {
    const statusIndicator = document.getElementById('helper-status-indicator');
    if (!statusIndicator) return;

    const statusText = statusIndicator.querySelector('.status-text');

    try {
        const isRunning = await tauriAPI.checkHelper();
        helperAvailable = isRunning;

        statusIndicator.classList.remove('running', 'stopped');
        statusIndicator.classList.add(isRunning ? 'running' : 'stopped');
        statusText.textContent = isRunning ? 'Running' : 'Not installed';

        // Show/hide the Remove Helper Now button based on status
        const removeHelperBtn = document.getElementById('remove-helper-now-btn');
        if (removeHelperBtn) {
            if (isRunning) {
                removeHelperBtn.style.display = '';

                // Check if there are active blocks - if so, disable the button
                const hasActiveBlocks = hasAnyActiveBlocks();
                if (hasActiveBlocks) {
                    removeHelperBtn.disabled = true;
                    removeHelperBtn.title = 'Override all running blocks first before removing the helper';
                    removeHelperBtn.classList.add('disabled-with-reason');
                } else {
                    removeHelperBtn.disabled = false;
                    removeHelperBtn.title = '';
                    removeHelperBtn.classList.remove('disabled-with-reason');
                }
            } else {
                removeHelperBtn.style.display = 'none';
            }
        }
    } catch (e) {
        statusIndicator.classList.remove('running', 'stopped');
        statusIndicator.classList.add('stopped');
        statusText.textContent = 'Unknown';

        // Hide remove button on error too
        const removeHelperBtn = document.getElementById('remove-helper-now-btn');
        if (removeHelperBtn) {
            removeHelperBtn.style.display = 'none';
        }
    }

    // Also update Override All button visibility
    updateOverrideAllButtonVisibility();
}

// Check if there are any active blocks or schedules
function hasAnyActiveBlocks() {
    const now = Date.now();
    const nowDate = new Date();
    const currentDay = nowDate.getDay() === 0 ? 6 : nowDate.getDay() - 1;
    const currentMins = nowDate.getHours() * 60 + nowDate.getMinutes();

    // Check one-off blocks
    const hasActiveOneOff = appData.activeBlocks.some(block =>
        block.startTime <= now && block.endTime > now
    );
    if (hasActiveOneOff) return true;

    // Check schedules
    if (appData.schedules) {
        for (const schedule of appData.schedules) {
            if (!schedule.segments) continue;
            const isActive = schedule.segments.some(seg => {
                const startMins = seg.startHour * 60 + seg.startMinute;
                const endMins = seg.endHour * 60 + seg.endMinute;
                if (endMins > startMins) {
                    return seg.days.includes(currentDay) &&
                        currentMins >= startMins &&
                        currentMins < endMins;
                } else {
                    const yesterdayDay = currentDay === 0 ? 6 : currentDay - 1;
                    return (seg.days.includes(currentDay) && currentMins >= startMins) ||
                        (seg.days.includes(yesterdayDay) && currentMins < endMins);
                }
            });
            if (isActive) return true;
        }
    }

    return false;
}

// Update visibility of the Override All button based on active blocks
function updateOverrideAllButtonVisibility() {
    const overrideAllBtn = document.getElementById('override-all-btn');
    if (overrideAllBtn) {
        overrideAllBtn.style.display = hasAnyActiveBlocks() ? '' : 'none';
    }
}

// Show challenge for removing helper when blocks are active
async function showRemoveHelperChallenge() {
    return new Promise((resolve) => {
        // Find the hardest challenge from active blocks' blocklists
        const now = Date.now();
        let hardestDifficulty = { type: 'random-words', count: 50 }; // default
        let maxCount = 50;

        // Check active one-off blocks
        for (const block of appData.activeBlocks) {
            if (block.startTime <= now && block.endTime > now) {
                const bl = appData.blocklists.find(b => b.id === block.blocklistId);
                if (bl?.overrideDifficulty) {
                    const diff = bl.overrideDifficulty;
                    // Custom text is always hardest
                    if (diff.type === 'custom' && diff.customText) {
                        hardestDifficulty = diff;
                        break; // Custom is always hardest
                    }
                    // For gibberish/random-words, higher count = harder
                    if (diff.count > maxCount) {
                        maxCount = diff.count;
                        hardestDifficulty = diff;
                    }
                }
            }
        }

        // Check scheduled blocks too
        if (hardestDifficulty.type !== 'custom' && appData.schedules) {
            const nowDate = new Date();
            const currentDay = nowDate.getDay() === 0 ? 6 : nowDate.getDay() - 1;
            const currentMins = nowDate.getHours() * 60 + nowDate.getMinutes();

            for (const schedule of appData.schedules) {
                if (!schedule.segments) continue;
                const isActive = schedule.segments.some(seg => {
                    const startMins = seg.startHour * 60 + seg.startMinute;
                    const endMins = seg.endHour * 60 + seg.endMinute;
                    if (endMins > startMins) {
                        return seg.days.includes(currentDay) &&
                            currentMins >= startMins && currentMins < endMins;
                    } else {
                        const yesterdayDay = currentDay === 0 ? 6 : currentDay - 1;
                        return (seg.days.includes(currentDay) && currentMins >= startMins) ||
                            (seg.days.includes(yesterdayDay) && currentMins < endMins);
                    }
                });
                if (isActive) {
                    const bl = appData.blocklists.find(b => b.id === schedule.blocklistId);
                    if (bl?.overrideDifficulty) {
                        const diff = bl.overrideDifficulty;
                        if (diff.type === 'custom' && diff.customText) {
                            hardestDifficulty = diff;
                            break;
                        }
                        if (diff.count > maxCount) {
                            maxCount = diff.count;
                            hardestDifficulty = diff;
                        }
                    }
                }
            }
        }

        // Generate challenge text based on difficulty - use global challengeText so existing handlers work
        if (hardestDifficulty.type === 'custom' && hardestDifficulty.customText) {
            challengeText = hardestDifficulty.customText;
        } else if (hardestDifficulty.type === 'gibberish') {
            challengeText = generateGibberish(hardestDifficulty.count);
        } else {
            challengeText = generateRandomWords(hardestDifficulty.count);
        }
        challengeText = challengeText.replace(/[\r\n]+/g, ' ').replace(/\s{2,}/g, ' ').trim();

        // Close settings modal first so challenge modal appears on top
        document.getElementById('settings-modal').classList.add('hidden');

        // Use the existing override modal
        const modal = document.getElementById('override-modal');
        const titleEl = document.getElementById('override-modal-title');
        const summaryEl = document.getElementById('override-summary');
        const challengeTextEl = document.getElementById('challenge-text');
        const challengeInput = document.getElementById('challenge-input');
        const progressBar = document.getElementById('challenge-progress-bar');
        const confirmBtn = document.getElementById('confirm-override-btn');
        const cancelBtn = document.getElementById('cancel-override-btn');
        const scheduleOptions = document.getElementById('schedule-override-options');

        titleEl.textContent = 'Remove Helper?';
        summaryEl.innerHTML = '<strong>Warning:</strong> This will stop all website blocking. You have active blocks that will be cleared.';
        challengeTextEl.textContent = challengeText;
        challengeInput.value = '';
        progressBar.style.width = '0%';
        progressBar.style.background = 'linear-gradient(90deg, #dc2626 0%, #ef4444 100%)'; // Red for danger
        scheduleOptions.classList.add('hidden');

        // Store callback to be called by the existing confirm handler
        window.helperRemovalConfirmCallback = () => {
            modal.classList.add('hidden');
            overrideBlockId = null;
            window.helperRemovalConfirmCallback = null;
            window.helperRemovalCancelCallback = null;
            resolve(true);
        };

        window.helperRemovalCancelCallback = () => {
            modal.classList.add('hidden');
            overrideBlockId = null;
            window.helperRemovalConfirmCallback = null;
            window.helperRemovalCancelCallback = null;
            resolve(false);
        };

        // Set special block ID so existing handlers know this is helper removal
        overrideBlockId = 'helper-removal';

        modal.classList.remove('hidden');
        challengeInput.focus();
    });
}


// Variable to track override-all challenge text
let overrideAllChallengeText = '';

// Setup Override All functionality in settings
function setupOverrideAll() {
    const advancedToggle = document.getElementById('advanced-options-toggle');
    const advancedContent = document.getElementById('advanced-options-content');
    const overrideAllBtn = document.getElementById('override-all-btn');
    const overrideAllModal = document.getElementById('override-all-modal');
    const cancelOverrideAllBtn = document.getElementById('cancel-override-all-btn');
    const confirmOverrideAllBtn = document.getElementById('confirm-override-all-btn');
    const overrideAllChallengeInput = document.getElementById('override-all-challenge-input');
    const overrideAllProgressBar = document.getElementById('override-all-progress-bar');

    // Toggle advanced options
    if (advancedToggle && advancedContent) {
        advancedToggle.addEventListener('click', () => {
            advancedToggle.classList.toggle('expanded');
            advancedContent.classList.toggle('hidden');
        });
    }

    // Open override all modal
    if (overrideAllBtn && overrideAllModal) {
        overrideAllBtn.addEventListener('click', () => {
            // Close settings modal first
            document.getElementById('settings-modal').classList.add('hidden');

            // Find the hardest challenge among active blocks and schedules
            const hardestDifficulty = findHardestChallenge();

            // Generate challenge text based on hardest difficulty
            if (hardestDifficulty.type === 'custom' && hardestDifficulty.customText) {
                overrideAllChallengeText = hardestDifficulty.customText;
            } else if (hardestDifficulty.type === 'gibberish') {
                overrideAllChallengeText = generateGibberish(hardestDifficulty.count);
            } else {
                overrideAllChallengeText = generateRandomWords(hardestDifficulty.count);
            }

            // Sanitize: remove linebreaks and collapse multiple spaces
            overrideAllChallengeText = overrideAllChallengeText.replace(/[\r\n]+/g, ' ').replace(/\s{2,}/g, ' ').trim();

            // Display challenge
            document.getElementById('override-all-challenge-text').textContent = overrideAllChallengeText;
            overrideAllChallengeInput.value = '';
            overrideAllProgressBar.style.width = '0%';

            overrideAllModal.classList.remove('hidden');
        });
    }

    // Cancel override all
    if (cancelOverrideAllBtn && overrideAllModal) {
        cancelOverrideAllBtn.addEventListener('click', () => {
            overrideAllModal.classList.add('hidden');
            overrideAllChallengeText = '';
        });
    }

    // Click outside to close
    if (overrideAllModal) {
        overrideAllModal.addEventListener('click', (e) => {
            if (e.target === overrideAllModal) {
                overrideAllModal.classList.add('hidden');
                overrideAllChallengeText = '';
            }
        });
    }

    // Prevent paste
    if (overrideAllChallengeInput) {
        overrideAllChallengeInput.addEventListener('paste', (e) => {
            e.preventDefault();
        });

        // Update progress as user types
        overrideAllChallengeInput.addEventListener('input', () => {
            const typed = overrideAllChallengeInput.value;
            const target = overrideAllChallengeText;

            let correctChars = 0;
            for (let i = 0; i < typed.length && i < target.length; i++) {
                if (typed[i] === target[i]) {
                    correctChars++;
                } else {
                    break;
                }
            }

            const progress = (correctChars / target.length) * 100;
            overrideAllProgressBar.style.width = `${progress}%`;
        });

        // Enter key submits
        overrideAllChallengeInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                confirmOverrideAllBtn.click();
            }
        });
    }

    // Confirm override all
    if (confirmOverrideAllBtn) {
        confirmOverrideAllBtn.addEventListener('click', async () => {
            const typed = overrideAllChallengeInput.value;
            const target = overrideAllChallengeText;

            if (typed === target) {
                // Success! Clear everything
                await performOverrideAll();
                overrideAllModal.classList.add('hidden');
                overrideAllChallengeText = '';
            } else {
                // Wrong - wiggle modal
                const modalContent = overrideAllModal.querySelector('.modal-content');
                modalContent.classList.remove('wiggle');
                void modalContent.offsetWidth; // Trigger reflow
                modalContent.classList.add('wiggle');
            }
        });
    }
}

// Find the hardest challenge among all active blocks and schedules
function findHardestChallenge() {
    const now = Date.now();
    let hardestDifficulty = { type: 'random-words', count: 50 }; // Default

    // Check active one-off blocks
    for (const block of appData.activeBlocks) {
        if (block.startTime <= now && block.endTime > now) {
            const blocklist = appData.blocklists.find(bl => bl.id === block.blocklistId);
            if (blocklist?.overrideDifficulty) {
                hardestDifficulty = compareDifficulties(hardestDifficulty, blocklist.overrideDifficulty);
            }
        }
    }

    // Check active schedules
    for (const schedule of appData.schedules || []) {
        const blocklist = appData.blocklists.find(bl => bl.id === schedule.blocklistId);
        if (blocklist?.overrideDifficulty) {
            hardestDifficulty = compareDifficulties(hardestDifficulty, blocklist.overrideDifficulty);
        }
    }

    return hardestDifficulty;
}

// Compare two difficulties and return the harder one
function compareDifficulties(a, b) {
    // Custom text is considered hardest (user defined)
    if (b.type === 'custom' && b.customText) {
        const bLen = b.customText.length;
        const aLen = a.type === 'custom' && a.customText ? a.customText.length : (a.count || 50);
        return bLen >= aLen ? b : a;
    }
    if (a.type === 'custom' && a.customText) {
        return a;
    }

    // Gibberish is harder than random words at same count
    const aCount = a.count || 50;
    const bCount = b.count || 50;

    // If b has more characters, it's harder
    if (bCount > aCount) return b;
    if (aCount > bCount) return a;

    // Same count: gibberish is harder than random-words
    if (b.type === 'gibberish' && a.type !== 'gibberish') return b;
    if (a.type === 'gibberish' && b.type !== 'gibberish') return a;

    // Equal, return a
    return a;
}

// Perform the actual override-all operation
async function performOverrideAll() {
    try {
        // Clear all active blocks
        appData.activeBlocks = [];

        // Clear all schedules
        appData.schedules = [];

        // Save the data
        await saveData();

        // Clear website blocking via helper (this surgically removes our hosts entries)
        const status = await tauriAPI.checkHelperStatus();
        if (status.running) {
            await tauriAPI.clearBlockViaHelper();
        }

        // Update blocked apps (will stop watcher if no apps to block)
        await updateBlockedApps();

        // Re-render the UI
        render();

        // Reset the blocklist selection UI
        const blocklistSelect = document.getElementById('blocklist-select');
        if (blocklistSelect) {
            handleBlocklistSelect({ target: blocklistSelect });
        }

        console.log('Override all completed successfully');
    } catch (err) {
        console.error('Error during override all:', err);
    }
}

// ========================================
// DEV MODE: Test Runner Keyboard Shortcut
// ========================================
// Press Cmd+Shift+T (Mac) or Ctrl+Shift+T (Windows) to run tests
document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 't') {
        e.preventDefault();
        console.log('🧪 Test shortcut detected!');
        if (window.ReddBlockTests && typeof window.ReddBlockTests.runAllTests === 'function') {
            window.ReddBlockTests.runAllTests();
        } else {
            console.log('⚠️ Tests not loaded. Make sure test-utils.js and blocking-tests.js are included.');
        }
    }
});

// Also expose a global function for running tests directly from console
window.runBlockingTests = function () {
    if (window.ReddBlockTests && typeof window.ReddBlockTests.runAllTests === 'function') {
        window.ReddBlockTests.runAllTests();
    } else {
        console.log('⚠️ Tests not loaded. Try: window.ReddBlockTestUtils and window.ReddBlockTests');
    }
};

// Expose additional internals for integration tests
Object.assign(window.__REDDBLOCK_INTERNALS__, {
    saveData,
    updateHostsFile,
    tauriAPI,
    render
});

console.log('💡 To run blocking tests, type: runBlockingTests() in the console');

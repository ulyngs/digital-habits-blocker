// The screen list for the UI screenshot harness (scripts/ui/shoot.mjs).
//
// One entry per screenshot. Adding a screen should mean adding an object here,
// not editing the driver.
//
// `platform` is required, and it is not cosmetic. detectPlatform() has no Linux
// branch and falls through to `body.windows`, so an unstamped screenshot taken
// in a container or CI silently claims to be a Windows one. It also decides
// whether a screen exists at all: `handset-device` hides whole sections, so
// asking for a week calendar on `android` or `iphone` is asking for a screen the
// app never renders. The driver fails such a screen rather than emitting a blank
// PNG.
//
// Omit `clip` to capture the whole app; set it to zoom in on one component.
// Both are worth having: the full shots are the only place layout problems
// *between* sections show up, and the clipped ones are the only place a 9px
// band is big enough to judge.

import { fixtures } from './fixtures.js';

/**
 * @typedef {object} Screen
 * @property {string}   name      output filename stem
 * @property {object}   fixture   appData to boot with
 * @property {string}   platform  'windows' | 'mac' | 'ipad' | 'iphone' | 'android'
 * @property {string}  [theme]    'light' | 'dark'
 * @property {object}  [viewport] { width, height } — device size, not a crop
 * @property {string}  [clip]     selector to screenshot instead of the whole page
 * @property {Function} [prepare] async (page) => {} run after render, before the shot
 */

// Real device sizes. A phone rendered at desktop width is not a phone
// screenshot — the handset layout rules are width-dependent as well as
// class-dependent.
const IPHONE = { width: 390, height: 844 };
const ANDROID_PHONE = { width: 412, height: 915 };
const IPAD = { width: 1024, height: 768 };
const DESKTOP = { width: 1100, height: 900 };

/** @type {Screen[]} */
export const screens = [
    // ---- Whole app, per platform -------------------------------------------
    // The mobile ones are the home screen as a phone actually gets it: no week
    // calendar (hidden by `handset-device`), no title bar, no window controls.
    {
        name: 'home-windows',
        fixture: fixtures.crowdedWeek,
        platform: 'windows',
        viewport: DESKTOP,
    },
    {
        name: 'home-mac',
        fixture: fixtures.crowdedWeek,
        platform: 'mac',
        viewport: DESKTOP,
    },
    {
        name: 'home-ipad',
        fixture: fixtures.crowdedWeek,
        platform: 'ipad',
        viewport: IPAD,
    },
    {
        name: 'home-iphone',
        fixture: fixtures.crowdedWeek,
        platform: 'iphone',
        viewport: IPHONE,
    },
    {
        name: 'home-android',
        fixture: fixtures.crowdedWeek,
        platform: 'android',
        viewport: ANDROID_PHONE,
    },
    {
        name: 'home-windows-dark',
        fixture: fixtures.crowdedWeek,
        platform: 'windows',
        theme: 'dark',
        viewport: DESKTOP,
    },

    // ---- The week calendar on its own --------------------------------------
    {
        name: 'week-crowded',
        fixture: fixtures.crowdedWeek,
        platform: 'windows',
        viewport: DESKTOP,
        clip: '.week-calendar-section',
    },
    {
        name: 'week-crowded-dark',
        fixture: fixtures.crowdedWeek,
        platform: 'windows',
        theme: 'dark',
        viewport: DESKTOP,
        clip: '.week-calendar-section',
    },
    {
        // iPad is the *only* touch platform that shows this view, so it is the
        // one screen where the label-free bands' hover-only tooltip fallback is
        // genuinely unavailable to the user.
        name: 'week-crowded-ipad',
        fixture: fixtures.crowdedWeek,
        platform: 'ipad',
        viewport: IPAD,
        clip: '.week-calendar-section',
    },
    {
        name: 'week-single',
        fixture: fixtures.singleSchedule,
        platform: 'windows',
        viewport: DESKTOP,
        clip: '.week-calendar-section',
    },

    // ---- The focus-space editor -------------------------------------------
    // One form for create (modal) and edit (panel; sheet on phones). The sole
    // space in the fixture is auto-selected, so the panel shows its editor.
    {
        name: 'editor-edit-weekly',
        fixture: fixtures.singleSchedule,
        platform: 'mac',
        viewport: DESKTOP,
        clip: '#time-picker-container',
        prepare: async (page) => {
            await page.click('#editor-section-when-header');
        },
    },
    {
        name: 'editor-edit-stop-early',
        fixture: fixtures.singleSchedule,
        platform: 'mac',
        viewport: DESKTOP,
        clip: '#time-picker-container',
        prepare: async (page) => {
            await page.click('#editor-section-stop-header');
        },
    },
    {
        name: 'editor-create',
        fixture: fixtures.singleSchedule,
        platform: 'mac',
        viewport: DESKTOP,
        clip: '#blocklist-modal .modal-content',
        prepare: async (page) => {
            // A fresh space opens on What to block; type a website and pick nothing else.
            await page.click('#add-blocklist-btn');
            await page.fill('#modal-website-input', 'reddit.com');
            await page.keyboard.press('Enter');
        },
    },
    {
        name: 'editor-edit-weekly-dark',
        fixture: fixtures.singleSchedule,
        platform: 'mac',
        theme: 'dark',
        viewport: DESKTOP,
        clip: '#time-picker-container',
        prepare: async (page) => {
            await page.click('#editor-section-when-header');
        },
    },
    {
        name: 'editor-edit-what',
        fixture: fixtures.singleSchedule,
        platform: 'mac',
        viewport: DESKTOP,
        clip: '#time-picker-container',
        prepare: async (page) => {
            await page.click('#editor-section-what-header');
        },
    },
    {
        name: 'editor-edit-advanced',
        fixture: fixtures.singleSchedule,
        platform: 'mac',
        viewport: DESKTOP,
        clip: '#time-picker-container',
        prepare: async (page) => {
            await page.click('#editor-section-advanced-header');
        },
    },
    {
        name: 'editor-create-daily',
        fixture: fixtures.singleSchedule,
        platform: 'mac',
        viewport: DESKTOP,
        clip: '#blocklist-modal .modal-content',
        prepare: async (page) => {
            await page.click('#add-blocklist-btn');
            await page.click('#editor-section-when-header');
            await page.click('#when-kind-daily');
            await page.click('#until-date');
        },
    },
    {
        name: 'editor-edit-manual',
        fixture: fixtures.manualRunning,
        platform: 'mac',
        viewport: DESKTOP,
        clip: '#time-picker-container',
        prepare: async (page) => {
            // Locked space with websites and an app: chips render as locked.
            await page.click('#editor-section-what-header');
        },
    },
    {
        name: 'editor-edit-iphone',
        fixture: fixtures.singleSchedule,
        platform: 'iphone',
        viewport: IPHONE,
        prepare: async (page) => {
            await page.click('.blocklist-card');
            await page.click('#editor-section-when-header');
        },
    },
];

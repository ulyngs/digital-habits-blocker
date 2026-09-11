import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('Windows Store sign-in startup manifest', () => {
    it('starts the packaged application by default without a script wrapper', () => {
        const script = readFileSync('scripts/build-msix.ps1', 'utf8');
        const xml = script.split('$manifest = @"')[1].split('"@')[0].trim();
        const manifest = new DOMParser().parseFromString(xml, 'application/xml');
        expect(manifest.querySelector('parsererror')).toBeNull();
        const namespace = 'http://schemas.microsoft.com/appx/manifest/desktop/windows10';
        const tasks = manifest.getElementsByTagNameNS(namespace, 'StartupTask');
        expect(tasks.length).toBe(1);
        const task = tasks[0];
        expect(task.getAttribute('Enabled')).toBe('true');
        expect(task.getAttribute('TaskId')).toBeTruthy();
        expect(task.getAttribute('DisplayName')).toBe('Digital Habits: Blocker');
        const extension = task.parentElement;
        expect(extension.getAttribute('Category')).toBe('windows.startupTask');
        expect(extension.getAttribute('Executable')).toBe(
            manifest.getElementsByTagName('Application')[0].getAttribute('Executable'),
        );
        expect(extension.getAttribute('EntryPoint')).toBe('Windows.FullTrustApplication');
    });
});

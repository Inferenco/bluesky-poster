import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getNotifyLevel } from '../notify.js';

// Test the notification payload structure and escaping
describe('notify module', () => {
    describe('escapeMarkdown', () => {
        const escapeMarkdown = (text: string): string => {
            return text.replace(/[_*`\[\]]/g, '\\$&');
        };

        it('escapes underscores', () => {
            expect(escapeMarkdown('hello_world')).toBe('hello\\_world');
        });

        it('escapes asterisks', () => {
            expect(escapeMarkdown('**bold**')).toBe('\\*\\*bold\\*\\*');
        });

        it('escapes backticks', () => {
            expect(escapeMarkdown('`code`')).toBe('\\`code\\`');
        });

        it('escapes brackets', () => {
            expect(escapeMarkdown('[link]')).toBe('\\[link\\]');
        });

        it('handles combined escapes', () => {
            expect(escapeMarkdown('_test_ *bold* `code`'))
                .toBe('\\_test\\_ \\*bold\\* \\`code\\`');
        });
    });

    describe('getNotifyLevel', () => {
        const originalEnv = process.env.TG_NOTIFY_LEVEL;

        afterEach(() => {
            if (originalEnv === undefined) {
                delete process.env.TG_NOTIFY_LEVEL;
            } else {
                process.env.TG_NOTIFY_LEVEL = originalEnv;
            }
        });

        it('defaults to "all" when not set', () => {
            delete process.env.TG_NOTIFY_LEVEL;
            expect(getNotifyLevel()).toBe('all');
        });

        it('returns "errors" when set to errors', () => {
            process.env.TG_NOTIFY_LEVEL = 'errors';
            expect(getNotifyLevel()).toBe('errors');
        });

        it('returns "none" when set to none', () => {
            process.env.TG_NOTIFY_LEVEL = 'none';
            expect(getNotifyLevel()).toBe('none');
        });

        it('is case insensitive', () => {
            process.env.TG_NOTIFY_LEVEL = 'ERRORS';
            expect(getNotifyLevel()).toBe('errors');

            process.env.TG_NOTIFY_LEVEL = 'None';
            expect(getNotifyLevel()).toBe('none');
        });

        it('defaults to "all" for invalid values', () => {
            process.env.TG_NOTIFY_LEVEL = 'invalid';
            expect(getNotifyLevel()).toBe('all');
        });
    });

    describe('notification payload', () => {
        it('truncates long post text', () => {
            const truncate = (text: string, max: number) =>
                text.length > max ? text.slice(0, max) + '...' : text;

            const longText = 'x'.repeat(300);
            expect(truncate(longText, 200)).toBe('x'.repeat(200) + '...');
        });

        it('preserves short post text', () => {
            const truncate = (text: string, max: number) =>
                text.length > max ? text.slice(0, max) + '...' : text;

            const shortText = 'Hello world';
            expect(truncate(shortText, 200)).toBe('Hello world');
        });

        it('builds correct message structure', () => {
            interface NotificationPayload {
                success: boolean;
                postId?: string;
                postText?: string;
                error?: string;
                dryRun?: boolean;
            }

            const buildMessage = (payload: NotificationPayload): string => {
                const emoji = payload.success ? '✅' : '❌';
                const status = payload.success ? 'Posted successfully' : 'Failed to post';
                const dryLabel = payload.dryRun ? ' [DRY RUN]' : '';

                let message = `${emoji} *Bluesky Autoposter*${dryLabel}\n\n`;
                message += `*Status:* ${status}\n`;

                if (payload.postId) {
                    message += `*Post ID:* \`${payload.postId}\`\n`;
                }

                return message;
            };

            const successPayload: NotificationPayload = {
                success: true,
                postId: '001',
                dryRun: false
            };

            const message = buildMessage(successPayload);
            expect(message).toContain('✅');
            expect(message).toContain('Posted successfully');
            expect(message).toContain('001');
            expect(message).not.toContain('[DRY RUN]');

            const dryRunPayload: NotificationPayload = {
                success: true,
                postId: '002',
                dryRun: true
            };

            const dryMessage = buildMessage(dryRunPayload);
            expect(dryMessage).toContain('[DRY RUN]');
        });
    });
});


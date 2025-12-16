/**
 * Optional Telegram notifications for post success/failure.
 * 
 * Environment variables:
 * - TG_BOT_TOKEN: Telegram bot token from @BotFather
 * - TG_CHAT_ID: Chat ID to send notifications to
 * - TG_NOTIFY_LEVEL: "all" | "errors" | "none" (default: "all")
 *   - "all": Send notifications for both success and errors
 *   - "errors": Only send notifications for failures
 *   - "none": Disable all notifications
 */

export type NotifyLevel = 'all' | 'errors' | 'none';

export interface NotificationPayload {
    success: boolean;
    postId?: string;
    postText?: string;
    error?: string;
    dryRun?: boolean;
}

export function getNotifyLevel(): NotifyLevel {
    const level = (process.env.TG_NOTIFY_LEVEL || 'all').toLowerCase();
    if (level === 'errors' || level === 'none') {
        return level;
    }
    return 'all';
}

export async function sendTelegramNotification(payload: NotificationPayload): Promise<void> {
    const token = process.env.TG_BOT_TOKEN;
    const chatId = process.env.TG_CHAT_ID;

    if (!token || !chatId) {
        // Notifications not configured, skip silently
        return;
    }

    const level = getNotifyLevel();

    // Check if we should send based on level
    if (level === 'none') {
        return;
    }
    if (level === 'errors' && payload.success) {
        // Only errors mode, but this is a success — skip
        return;
    }

    const emoji = payload.success ? '✅' : '❌';
    const status = payload.success ? 'Posted successfully' : 'Failed to post';
    const dryLabel = payload.dryRun ? ' [DRY RUN]' : '';

    let message = `${emoji} *Bluesky Autoposter*${dryLabel}\n\n`;
    message += `*Status:* ${status}\n`;

    if (payload.postId) {
        message += `*Post ID:* \`${payload.postId}\`\n`;
    }

    if (payload.postText) {
        // Truncate for Telegram (max ~4096 chars, but keep it short)
        const truncated = payload.postText.length > 200
            ? payload.postText.slice(0, 200) + '...'
            : payload.postText;
        message += `*Text:* ${escapeMarkdown(truncated)}\n`;
    }

    if (payload.error) {
        message += `*Error:* \`${escapeMarkdown(payload.error.slice(0, 200))}\`\n`;
    }

    message += `\n_${new Date().toISOString()}_`;

    try {
        const url = `https://api.telegram.org/bot${token}/sendMessage`;
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_id: chatId,
                text: message,
                parse_mode: 'Markdown'
            })
        });

        if (!response.ok) {
            const text = await response.text();
            console.error('Telegram notification failed:', text);
        }
    } catch (err) {
        console.error('Telegram notification error:', err);
    }
}

function escapeMarkdown(text: string): string {
    return text.replace(/[_*`\[\]]/g, '\\$&');
}


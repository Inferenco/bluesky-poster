export interface SelectableMessage {
  id: string;
  body: string;
  status: string;
  weight: number;
  cooldown_hours: number;
  normalised_hash: string;
  last_posted_at: Date | string | null;
}

export interface EligibilityOptions {
  now: Date;
  recentHashes: string[];
}

export function selectEligibleMessages<T extends SelectableMessage>(messages: T[], options: EligibilityOptions): T[] {
  const recentHashes = new Set(options.recentHashes);
  return messages.filter((message) => {
    if (message.status !== 'approved') return false;
    if (recentHashes.has(message.normalised_hash)) return false;
    if (!message.last_posted_at) return true;

    const postedAt = new Date(message.last_posted_at).getTime();
    if (Number.isNaN(postedAt)) return true;

    const cooldownMs = message.cooldown_hours * 60 * 60 * 1000;
    return options.now.getTime() - postedAt >= cooldownMs;
  });
}

export function pickWeightedMessage<T extends SelectableMessage>(messages: T[], random: () => number = Math.random): T | null {
  const weighted = messages.filter((message) => message.weight > 0);
  const totalWeight = weighted.reduce((sum, message) => sum + message.weight, 0);
  if (totalWeight <= 0) return null;

  let threshold = random() * totalWeight;
  for (const message of weighted) {
    threshold -= message.weight;
    if (threshold < 0) return message;
  }

  return weighted.at(-1) ?? null;
}

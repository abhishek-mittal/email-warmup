import { Injectable, Logger } from '@nestjs/common';
import { Anthropic } from '@anthropic-ai/sdk';

export interface WarmupEmailPrompt {
  warmupDay: number;
  industry?: string | null;
}

export interface WarmupEmail {
  subject: string;
  text: string;
  html: string;
}

const CLAUDE_MODEL = 'claude-haiku-4-5';
const CLAUDE_TIMEOUT_MS = 10_000;

const ANGLES = [
  'a quick check-in',
  'following up on a previous conversation',
  'sharing a short update',
  'asking a quick question',
  'thanking them for their time',
  'proposing a quick call',
  'sharing something potentially useful',
  'a casual hello after a while',
];

const TONES = ['friendly and casual', 'brief and professional', 'warm and conversational'];

const FALLBACK_SUBJECTS = [
  'Quick hello',
  'Checking in',
  'Following up',
  'Quick question for you',
  'Got a minute?',
  'Touching base',
  'Hope you are doing well',
  'Quick update on my end',
  'Thought of you',
  'Circling back',
];

const FALLBACK_BODIES = [
  'Hey, hope things have been going well on your end lately. Wanted to say hi and see how things are.',
  'Hi there, it has been a little while — just checking in to see how everything is going for you.',
  'Hello, following up on our last chat. No rush at all, just wanted to keep in touch.',
  'Hey, quick one — how has your week been so far? Things have been steady on my side.',
  'Hi, hope you are having a good one. Wanted to reach out and say hello.',
  'Hey there, just wanted to drop a quick note to check in and see how you are doing.',
  'Hello, it has been a bit since we last spoke. Hope all is well on your end.',
  'Hi, no big update, just wanted to touch base and see how things are progressing.',
  'Hey, hope the week is treating you well. Wanted to send a quick hello.',
  'Hi there, thought I would check in and see how things are going for you these days.',
];

@Injectable()
export class ContentService {
  private readonly logger = new Logger(ContentService.name);
  private readonly client: Anthropic;

  // 50 short fallback templates used when the Claude API call times out or errors.
  // Subjects/bodies are intentionally varied so consecutive fallback sends don't
  // look identical to mail providers.
  static readonly FALLBACK_TEMPLATES: WarmupEmail[] = Array.from({ length: 50 }, (_, i) => {
    const n = i + 1;
    const subject = FALLBACK_SUBJECTS[i % FALLBACK_SUBJECTS.length].replace('{n}', String(n));
    const text = FALLBACK_BODIES[i % FALLBACK_BODIES.length].replace('{n}', String(n));
    return {
      subject,
      text,
      html: `<p>${text}</p>`,
    };
  });

  constructor() {
    this.client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }

  async generateEmail(prompt: WarmupEmailPrompt): Promise<WarmupEmail> {
    try {
      return await this.withTimeout(this.callClaude(prompt), CLAUDE_TIMEOUT_MS);
    } catch (err) {
      this.logger.warn(
        `Claude content generation failed, using fallback template: ${(err as Error).message}`,
      );
      return this.pickFallbackTemplate();
    }
  }

  async generateReply(original: WarmupEmail, prompt: WarmupEmailPrompt): Promise<WarmupEmail> {
    try {
      return await this.withTimeout(this.callClaude(prompt, original), CLAUDE_TIMEOUT_MS);
    } catch (err) {
      this.logger.warn(
        `Claude reply generation failed, using fallback template: ${(err as Error).message}`,
      );
      return this.pickFallbackTemplate();
    }
  }

  private withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Claude API call timed out')), ms);
      promise
        .then((value) => {
          clearTimeout(timer);
          resolve(value);
        })
        .catch((err) => {
          clearTimeout(timer);
          reject(err);
        });
    });
  }

  private async callClaude(
    prompt: WarmupEmailPrompt,
    replyingTo?: WarmupEmail,
  ): Promise<WarmupEmail> {
    const angle = ANGLES[Math.floor(Math.random() * ANGLES.length)];
    const tone = TONES[Math.floor(Math.random() * TONES.length)];
    const industryLine = prompt.industry
      ? `The recipient works in the ${prompt.industry} industry — make the content feel relevant to that space without being overtly sales-y.`
      : 'No specific industry context is available — keep the content generic but human.';

    const taskLines = replyingTo
      ? [
          'You are writing a short, realistic reply to the email below, as the original recipient replying back.',
          `Original subject: ${replyingTo.subject}`,
          `Original body: ${replyingTo.text}`,
          `This is warmup day ${prompt.warmupDay}. Write the reply in a ${tone} tone, ${angle}.`,
        ]
      : [
          'You are generating a short, realistic warmup email between two real professionals who already know each other a little.',
          `This is warmup day ${prompt.warmupDay}. The email should read as ${angle}, written in a ${tone} tone.`,
        ];

    const response = await this.client.messages.create({
      model: CLAUDE_MODEL,
      max_tokens: 400,
      messages: [
        {
          role: 'user',
          content: [
            ...taskLines,
            industryLine,
            'Keep it short (2-4 sentences). Do not mention warmup, deliverability, or that this is automated.',
            'Respond ONLY with strict JSON of the shape: {"subject": string, "text": string, "html": string}.',
            `Vary phrasing — random seed: ${Math.random().toString(36).slice(2)}.`,
          ].join('\n'),
        },
      ],
    });

    const block = response.content.find((c) => c.type === 'text');
    if (!block || block.type !== 'text') {
      throw new Error('Claude response had no text content');
    }

    const parsed = JSON.parse(block.text);
    if (!parsed.subject || !parsed.text || !parsed.html) {
      throw new Error('Claude response JSON missing required fields');
    }

    return {
      subject: String(parsed.subject),
      text: String(parsed.text),
      html: String(parsed.html),
    };
  }

  private pickFallbackTemplate(): WarmupEmail {
    const templates = ContentService.FALLBACK_TEMPLATES;
    return templates[Math.floor(Math.random() * templates.length)];
  }
}

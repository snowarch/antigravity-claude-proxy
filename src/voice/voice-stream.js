/**
 * Claude Code /voice WebSocket Speech-to-Text handler.
 *
 * Implements the `/api/ws/speech_to_text/voice_stream` protocol expected by
 * Claude Code CLI and transcribes incoming linear16 PCM audio using Gemini via
 * the proxy's Cloud Code client (multi-account rotation & automatic failover).
 */

import { sendMessage, getAvailableModelIds } from '../cloudcode/index.js';
import { logger } from '../utils/logger.js';
import { acceptWebSocket } from './ws-codec.js';

export const VOICE_STREAM_PATH = '/api/ws/speech_to_text/voice_stream';

const DEFAULT_SAMPLE_RATE = 16000;
const DEFAULT_CHANNELS = 1;
const MAX_AUDIO_SECONDS = 120;
const MIN_AUDIO_SECONDS = 0.15;
// Minimum RMS amplitude (out of 32768 for 16-bit PCM) to treat audio as containing speech.
// Prevents Gemini from hallucinating phrases on pure silence.
const SILENCE_RMS_THRESHOLD = 120;
// Trigger periodic interim transcription on long dictations (>3s of audio).
const INTERIM_INTERVAL_SECONDS = 3;

const PREFERRED_VOICE_MODELS = [
    'gemini-3.8-flash-low',
    'gemini-3.5-flash-lite',
    'gemini-3-flash',
    'gemini-2.5-flash-lite',
    'gemini-2.5-flash'
];

/**
 * Wrap raw signed 16-bit little-endian PCM bytes in a 44-byte RIFF/WAVE header.
 *
 * @param {Buffer} pcmBuffer
 * @param {number} [sampleRate=16000]
 * @param {number} [channels=1]
 * @returns {Buffer}
 */
export function pcmToWav(pcmBuffer, sampleRate = DEFAULT_SAMPLE_RATE, channels = DEFAULT_CHANNELS) {
    const bitsPerSample = 16;
    const byteRate = sampleRate * channels * (bitsPerSample / 8);
    const blockAlign = channels * (bitsPerSample / 8);
    const dataSize = pcmBuffer.length;

    const header = Buffer.alloc(44);
    header.write('RIFF', 0);
    header.writeUInt32LE(36 + dataSize, 4);
    header.write('WAVE', 8);
    header.write('fmt ', 12);
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20); // PCM
    header.writeUInt16LE(channels, 22);
    header.writeUInt32LE(sampleRate, 24);
    header.writeUInt32LE(byteRate, 28);
    header.writeUInt16LE(blockAlign, 32);
    header.writeUInt16LE(bitsPerSample, 34);
    header.write('data', 36);
    header.writeUInt32LE(dataSize, 40);

    return Buffer.concat([header, pcmBuffer]);
}

/**
 * Check whether 16-bit LE PCM audio contains energy above the silence floor.
 *
 * @param {Buffer} pcmBuffer
 * @param {number} [threshold=SILENCE_RMS_THRESHOLD]
 * @returns {boolean}
 */
export function hasSpeechEnergy(pcmBuffer, threshold = SILENCE_RMS_THRESHOLD) {
    const sampleCount = Math.floor(pcmBuffer.length / 2);
    if (sampleCount === 0) return false;

    let sumSq = 0;
    for (let i = 0; i < sampleCount; i++) {
        const s = pcmBuffer.readInt16LE(i * 2);
        sumSq += s * s;
    }
    const rms = Math.sqrt(sumSq / sampleCount);
    return rms >= threshold;
}

/**
 * Pick the fastest available Gemini Flash model for voice transcription.
 *
 * @param {string[]} availableModels
 * @param {string} [overrideModel]
 * @returns {string}
 */
export function resolveVoiceModel(availableModels = [], overrideModel = process.env.VOICE_MODEL) {
    if (overrideModel && overrideModel.trim()) {
        return overrideModel.trim();
    }

    if (Array.isArray(availableModels) && availableModels.length > 0) {
        const availSet = new Set(availableModels);
        for (const candidate of PREFERRED_VOICE_MODELS) {
            if (availSet.has(candidate)) return candidate;
        }
        const anyFlash = availableModels.find(m => m.includes('gemini') && m.includes('flash'));
        if (anyFlash) return anyFlash;
        const anyGemini = availableModels.find(m => m.includes('gemini'));
        if (anyGemini) return anyGemini;
    }

    return PREFERRED_VOICE_MODELS[0];
}

/**
 * Clean transcription text returned by Gemini.
 *
 * @param {string} raw
 * @returns {string}
 */
export function cleanTranscript(raw) {
    if (typeof raw !== 'string') return '';
    let text = raw.trim();
    if (!text) return '';
    // Strip wrapping quotes if the model added them
    if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) {
        text = text.slice(1, -1).trim();
    }
    if (/^(?:\[?silence\]?|\[?no speech\]?|\[?inaudible\]?|empty|none)$/i.test(text)) {
        return '';
    }
    return text;
}

/**
 * Transcribe linear16 PCM audio via Cloud Code Gemini.
 *
 * @param {Object} params
 * @returns {Promise<string>}
 */
export async function transcribeAudioBuffer({
    pcmBuffer,
    sampleRate = DEFAULT_SAMPLE_RATE,
    channels = DEFAULT_CHANNELS,
    language = '',
    keyterms = '',
    accountManager,
    sendMessageFn = sendMessage,
    getAvailableModelIdsFn = getAvailableModelIds
}) {
    const minBytes = Math.floor(sampleRate * channels * 2 * MIN_AUDIO_SECONDS);
    if (!pcmBuffer || pcmBuffer.length < minBytes) {
        return '';
    }
    if (!hasSpeechEnergy(pcmBuffer)) {
        return '';
    }

    const wav = pcmToWav(pcmBuffer, sampleRate, channels);
    const available = typeof getAvailableModelIdsFn === 'function' ? getAvailableModelIdsFn() : [];
    const model = resolveVoiceModel(available);

    const promptLines = [
        'Transcribe the spoken audio verbatim.',
        'Return ONLY the exact spoken words with natural punctuation, no commentary, no timestamps, and no quotes.',
        'If there is no intelligible speech, return an empty response.'
    ];
    if (language) {
        promptLines.push(`Expected language hint (still transcribe whatever language is actually spoken): ${language}.`);
    }
    if (keyterms) {
        promptLines.push(`Relevant technical terms and vocabulary that may appear: ${keyterms}.`);
    }

    const anthropicRequest = {
        model,
        max_tokens: 512,
        temperature: 0,
        messages: [{
            role: 'user',
            content: [
                {
                    type: 'document',
                    source: {
                        type: 'base64',
                        media_type: 'audio/wav',
                        data: wav.toString('base64')
                    }
                },
                {
                    type: 'text',
                    text: promptLines.join(' ')
                }
            ]
        }]
    };

    const response = await sendMessageFn(anthropicRequest, accountManager, true);
    const text = (response?.content || [])
        .filter(block => block?.type === 'text' && typeof block.text === 'string')
        .map(block => block.text)
        .join(' ');

    return cleanTranscript(text);
}

/**
 * Handle an incoming WebSocket upgrade for `/api/ws/speech_to_text/voice_stream`.
 *
 * @param {import('http').IncomingMessage} req
 * @param {import('stream').Duplex} socket
 * @param {Buffer} head
 * @param {Object} deps
 */
export function handleVoiceStreamUpgrade(req, socket, head, deps) {
    const {
        accountManager,
        ensureInitialized,
        sendMessageFn = sendMessage,
        getAvailableModelIdsFn = getAvailableModelIds
    } = deps;

    const parsedUrl = new URL(req.url || '/', 'http://localhost');
    const sampleRate = Math.max(8000, Math.min(48000, parseInt(parsedUrl.searchParams.get('sample_rate') || String(DEFAULT_SAMPLE_RATE), 10) || DEFAULT_SAMPLE_RATE));
    const channels = Math.max(1, Math.min(2, parseInt(parsedUrl.searchParams.get('channels') || String(DEFAULT_CHANNELS), 10) || DEFAULT_CHANNELS));
    const language = (parsedUrl.searchParams.get('language') || '').trim();
    const keyterms = typeof req.headers['x-config-keyterms'] === 'string'
        ? req.headers['x-config-keyterms'].slice(0, 1024)
        : '';

    const ws = acceptWebSocket(req, socket, head);
    if (!ws) return;

    const maxAudioBytes = sampleRate * channels * 2 * MAX_AUDIO_SECONDS;
    const interimStepBytes = sampleRate * channels * 2 * INTERIM_INTERVAL_SECONDS;
    const chunks = [];
    let totalBytes = 0;
    let closedStream = false;
    let interimInFlight = false;
    let lastInterimBytes = 0;

    logger.info(`[Voice] Session opened (rate=${sampleRate}, ch=${channels}, lang=${language || 'auto'})`);

    const maybeRunInterim = () => {
        if (closedStream || interimInFlight || ws.closed) return;
        const needed = lastInterimBytes === 0 ? interimStepBytes : lastInterimBytes + interimStepBytes;
        if (totalBytes < needed) return;

        interimInFlight = true;
        lastInterimBytes = totalBytes;
        const snapshot = Buffer.concat(chunks, totalBytes);

        (async () => {
            try {
                if (typeof ensureInitialized === 'function') {
                    await ensureInitialized();
                }
                const text = await transcribeAudioBuffer({
                    pcmBuffer: snapshot,
                    sampleRate,
                    channels,
                    language,
                    keyterms,
                    accountManager,
                    sendMessageFn,
                    getAvailableModelIdsFn
                });
                if (!closedStream && !ws.closed && text) {
                    ws.sendJson({ type: 'TranscriptInterim', data: text });
                }
            } catch (err) {
                logger.debug(`[Voice] Interim transcription skipped: ${err.message}`);
            } finally {
                interimInFlight = false;
            }
        })();
    };

    const finalizeStream = async () => {
        if (closedStream) return;
        closedStream = true;

        // Cancel Claude Code's 1500ms noData timer without overwriting pending interim text,
        // giving Gemini the full 5000ms safety window to return the final transcript.
        ws.sendJson({ type: 'TranscriptInterim', data: '' });

        const pcmBuffer = Buffer.concat(chunks, totalBytes);
        const durationSec = (pcmBuffer.length / (sampleRate * channels * 2)).toFixed(2);
        logger.info(`[Voice] Finalizing ${durationSec}s of audio (${pcmBuffer.length} bytes)`);

        try {
            if (typeof ensureInitialized === 'function') {
                await ensureInitialized();
            }
            const transcript = await transcribeAudioBuffer({
                pcmBuffer,
                sampleRate,
                channels,
                language,
                keyterms,
                accountManager,
                sendMessageFn,
                getAvailableModelIdsFn
            });

            if (ws.closed) return;

            if (transcript) {
                ws.sendJson({ type: 'TranscriptText', data: transcript });
            }
            ws.sendJson({ type: 'TranscriptEndpoint' });
            logger.info(`[Voice] Transcript delivered (${transcript.length} chars)`);
        } catch (err) {
            logger.error(`[Voice] Transcription failed: ${err.message}`);
            if (!ws.closed) {
                ws.sendJson({
                    type: 'TranscriptError',
                    error_code: 'transcription_failed',
                    description: err.message
                });
            }
        }
    };

    ws.on('message', (data, isBinary) => {
        if (isBinary) {
            if (closedStream) return;
            if (totalBytes >= maxAudioBytes) return;
            const remaining = maxAudioBytes - totalBytes;
            const slice = data.length > remaining ? data.subarray(0, remaining) : data;
            chunks.push(slice);
            totalBytes += slice.length;
            maybeRunInterim();
            return;
        }

        let frame;
        try {
            frame = JSON.parse(data);
        } catch {
            return;
        }

        if (frame?.type === 'KeepAlive') {
            return;
        }

        if (frame?.type === 'CloseStream') {
            finalizeStream();
        }
    });

    ws.on('error', (err) => {
        logger.debug(`[Voice] WebSocket error: ${err.message}`);
    });

    ws.on('close', () => {
        closedStream = true;
    });
}

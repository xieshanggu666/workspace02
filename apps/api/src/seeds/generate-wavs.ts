/**
 * 程序化生成演示用 WAV（16kHz / 单声道 / 16-bit PCM）。
 * 不是真人录音，仅用于让示例元数据有可播放、可显示波形的占位音频：
 * 每个音节一段带基频轮廓的衰减正弦，音节之间留静音，节奏取自 syllables 标注。
 */

export interface WavMark {
  start: number;
  end: number;
  label: string;
}

export function generateWavBuffer(
  marks: WavMark[],
  durationSec: number,
  baseFreq: number,
  sampleRate = 16000,
): { buffer: Buffer; peaks: number[] } {
  const total = Math.ceil(durationSec * sampleRate);
  const pcm = new Int16Array(total);

  marks.forEach((mark, idx) => {
    const start = Math.floor(mark.start * sampleRate);
    const end = Math.min(total, Math.floor(mark.end * sampleRate));
    const syllableLen = Math.max(1, end - start);
    for (let i = start; i < end; i++) {
      const t = (i - start) / syllableLen;
      // 音高轮廓：随音节在词中的位置上扬/下落，模拟声调
      const contour = 1 + 0.18 * Math.sin(2 * Math.PI * (idx + 1) * t + idx * 0.7);
      const freq = baseFreq * contour;
      // 包络：快起音、缓收音，避免咔哒声
      const attack = Math.min(1, (i - start) / (0.01 * sampleRate));
      const release = Math.min(1, (end - i) / (0.04 * sampleRate));
      const env = Math.min(attack, release) * (1 - 0.35 * t);
      const v = 0.5 * env * Math.sin((2 * Math.PI * freq * (i - start)) / sampleRate);
      // 加点第二共振峰让元音有"人声"质感
      const v2 = 0.15 * env * Math.sin((2 * Math.PI * freq * 2.3 * (i - start)) / sampleRate);
      pcm[i] = Math.max(-32767, Math.min(32767, Math.round((v + v2) * 32767)));
    }
  });

  const buffer = encodeWav(pcm, sampleRate);

  // 按 10ms 一帧取峰值，供波形渲染
  const frame = Math.floor(sampleRate * 0.01);
  const peaks: number[] = [];
  for (let i = 0; i < total; i += frame) {
    let max = 0;
    for (let j = i; j < Math.min(total, i + frame); j++) {
      const a = Math.abs(pcm[j]) / 32768;
      if (a > max) max = a;
    }
    peaks.push(Number(max.toFixed(3)));
  }
  return { buffer, peaks };
}

function encodeWav(pcm: Int16Array, sampleRate: number): Buffer {
  const dataSize = pcm.length * 2;
  const buf = Buffer.alloc(44 + dataSize);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16); // PCM chunk size
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28); // byte rate
  buf.writeUInt16LE(2, 32); // block align
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(dataSize, 40);
  for (let i = 0; i < pcm.length; i++) buf.writeInt16LE(pcm[i], 44 + i * 2);
  return buf;
}

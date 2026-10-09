const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('ffmpeg-static');

ffmpeg.setFfmpegPath(ffmpegPath);

/**
 * Converte áudio de qualquer formato que o ffmpeg reconheça para OGG/Opus —
 * o formato que o WhatsApp de fato entrega/reproduz em mensagens de áudio (é o
 * mesmo usado nativamente pelas notas de voz). Sem essa conversão, áudio gravado
 * no navegador (webm/opus, produzido pelo MediaRecorder) é aceito no upload mas
 * não é entregue/reproduzido no destinatário.
 */
function convertToOggOpus(buffer) {
  return new Promise((resolve, reject) => {
    const id = crypto.randomBytes(8).toString('hex');
    const inputPath = path.join(os.tmpdir(), `${id}-in`);
    const outputPath = path.join(os.tmpdir(), `${id}-out.ogg`);

    const cleanup = () => {
      fs.unlink(inputPath, () => {});
      fs.unlink(outputPath, () => {});
    };

    fs.writeFileSync(inputPath, buffer);

    ffmpeg(inputPath)
      .audioCodec('libopus')
      .format('ogg')
      .on('error', (err) => {
        cleanup();
        reject(err);
      })
      .on('end', () => {
        try {
          const out = fs.readFileSync(outputPath);
          cleanup();
          resolve(out);
        } catch (err) {
          cleanup();
          reject(err);
        }
      })
      .save(outputPath);
  });
}

module.exports = { convertToOggOpus };

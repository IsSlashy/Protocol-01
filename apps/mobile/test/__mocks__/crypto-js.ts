/**
 * Mock: crypto-js
 */
import { createHash, createHmac } from 'crypto';

const CryptoJS: any = {
  lib: {
    WordArray: {
      create: (words: number[], sigBytes: number) => ({ words, sigBytes }),
    },
  },
  enc: {
    Utf8: {
      parse: (str: string) => {
        const buf = Buffer.from(str, 'utf8');
        const words: number[] = [];
        for (let i = 0; i < buf.length; i += 4) {
          words.push(((buf[i] || 0) << 24) | ((buf[i+1] || 0) << 16) | ((buf[i+2] || 0) << 8) | (buf[i+3] || 0));
        }
        return { words, sigBytes: buf.length };
      },
    },
  },
  HmacSHA512: (data: any, key: any) => {
    // Convert WordArray-like objects to Buffer
    function toBuffer(wa: any): Buffer {
      if (Buffer.isBuffer(wa)) return wa;
      if (typeof wa === 'string') return Buffer.from(wa, 'utf8');
      const { words, sigBytes } = wa;
      const buf = Buffer.alloc(sigBytes);
      for (let i = 0; i < sigBytes; i++) {
        buf[i] = (words[i >>> 2] >>> (24 - (i % 4) * 8)) & 0xff;
      }
      return buf;
    }
    const keyBuf = toBuffer(key);
    const dataBuf = toBuffer(data);
    const hmac = createHmac('sha512', keyBuf).update(dataBuf).digest();
    const words: number[] = [];
    for (let i = 0; i < hmac.length; i += 4) {
      words.push(((hmac[i] || 0) << 24) | ((hmac[i+1] || 0) << 16) | ((hmac[i+2] || 0) << 8) | (hmac[i+3] || 0));
    }
    return { words, sigBytes: hmac.length };
  },
};

export default CryptoJS;

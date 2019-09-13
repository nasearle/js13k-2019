// Sonant-X
//
// Copyright (c) 2014 Nicolas Vanhoren
//
// Sonant-X is a fork of js-sonant by Marcus Geelnard and Jake Taylor. It is
// still published using the same license (zlib license, see below).
//
// Copyright (c) 2011 Marcus Geelnard
// Copyright (c) 2008-2009 Jake Taylor
//
// This software is provided 'as-is', without any express or implied
// warranty. In no event will the authors be held liable for any damages
// arising from the use of this software.
//
// Permission is granted to anyone to use this software for any purpose,
// including commercial applications, and to alter it and redistribute it
// freely, subject to the following restrictions:
//
// 1. The origin of this software must not be misrepresented; you must not
//	claim that you wrote the original software. If you use this software
//	in a product, an acknowledgment in the product documentation would be
//	appreciated but is not required.
//
// 2. Altered source versions must be plainly marked as such, and must not be
//	misrepresented as being the original software.
//
// 3. This notice may not be removed or altered from any source
//	distribution.

let sonantxrGenerateSong, sonantxrGenerateSound;

(function() {
  const WAVE_SPS = 44100; // Samples per second
  const MAX_TIME = 33; // maximum time, in millis, that the generator can use consecutively

  // Oscillators
  function osc_sin(value) {
    return Math.sin(value * 6.283184);
  }

  function osc_square(value) {
    return osc_sin(value) < 0 ? -1 : 1;
  }

  function osc_saw(value) {
    return (value % 1) - 0.5;
  }

  function osc_tri(value) {
    const v2 = (value % 1) * 4;
    return v2 < 2 ? v2 - 1 : 3 - v2;
  }

  // Array of oscillator functions
  const oscillators = [osc_sin, osc_square, osc_saw, osc_tri];

  function getnotefreq(n) {
    return 0.00390625 * Math.pow(1.059463094, n - 128);
  }

  function generateBuffer(samples) {
    return {
      left: new Float32Array(samples),
      right: new Float32Array(samples),
    };
  }

  function applyDelay(chnBuf, waveSamples, instr, rowLen) {
    const p1 = (instr.fx_delay_time * rowLen) >> 1;
    const t1 = instr.fx_delay_amt / 255;

    let n1 = 0;
    while (n1 < waveSamples - p1) {
      const b1 = n1;
      const l = n1 + p1;
      chnBuf.left[l] += chnBuf.right[b1] * t1;
      chnBuf.right[l] += chnBuf.left[b1] * t1;
      n1++;
    }
  }

  function getAudioBuffer(ctx, mixBuf) {
    const buffer = ctx.createBuffer(2, mixBuf.left.length, WAVE_SPS); // Create Mono Source Buffer from Raw Binary
    buffer.getChannelData(0).set(mixBuf.left);
    buffer.getChannelData(1).set(mixBuf.right);
    return buffer;
  }

  const SoundGenerator = function(ctx, instr, rowLen) {
    this.ctx = ctx;
    this.instr = instr;
    this.rowLen = rowLen || 5605;

    this.osc_lfo = oscillators[instr.lfo_waveform];
    this.osc1 = oscillators[instr.osc1_waveform];
    this.osc2 = oscillators[instr.osc2_waveform];
    this.attack = instr.env_attack;
    this.sustain = instr.env_sustain;
    this.release = instr.env_release;
    this.panFreq = Math.pow(2, instr.fx_pan_freq - 8) / this.rowLen;
    this.lfoFreq = Math.pow(2, instr.lfo_freq - 8) / this.rowLen;
  };

  SoundGenerator.prototype._genSound = function(n, chnBuf, currentpos) {
    let c1 = 0;
    let c2 = 0;

    // Precalculate frequencues
    const o1t =
      getnotefreq(n + (this.instr.osc1_oct - 8) * 12 + this.instr.osc1_det) *
      (1 + 0.0008 * this.instr.osc1_detune);
    const o2t =
      getnotefreq(n + (this.instr.osc2_oct - 8) * 12 + this.instr.osc2_det) *
      (1 + 0.0008 * this.instr.osc2_detune);

    // State variable init
    const q = this.instr.fx_resonance / 255;
    let low = 0;
    let band = 0;

    const chnbufLength = chnBuf.left.length;
    const numSamples = this.attack + this.sustain + this.release - 1;

    for (let j = numSamples; j >= 0; --j) {
      let k = j + currentpos;

      // LFO
      const lfor =
        (this.osc_lfo(k * this.lfoFreq) * this.instr.lfo_amt) / 512 + 0.5;

      // Envelope
      let e = 1;
      if (j < this.attack) {
        e = j / this.attack;
      } else if (j >= this.attack + this.sustain) {
        e -= (j - this.attack - this.sustain) / this.release;
      }

      // Oscillator 1
      let t = o1t;
      if (this.instr.lfo_osc1_freq) {
        t += lfor;
      }
      if (this.instr.osc1_xenv) {
        t *= e * e;
      }
      c1 += t;
      let rsample = this.osc1(c1) * this.instr.osc1_vol;

      // Oscillator 2
      t = o2t;
      if (this.instr.osc2_xenv) {
        t *= e * e;
      }
      c2 += t;
      rsample += this.osc2(c2) * this.instr.osc2_vol;

      // Noise oscillator
      if (this.instr.noise_fader) {
        rsample += (2 * Math.random() - 1) * this.instr.noise_fader * e;
      }

      rsample *= e / 255;

      // State variable filter
      let f = this.instr.fx_freq;
      if (this.instr.lfo_fx_freq) {
        f *= lfor;
      }
      f = 1.5 * Math.sin((f * 3.141592) / WAVE_SPS);
      low += f * band;
      const high = q * (rsample - band) - low;
      band += f * high;
      switch (this.instr.fx_filter) {
        case 1: // Hipass
          rsample = high;
          break;
        case 2: // Lopass
          rsample = low;
          break;
        case 3: // Bandpass
          rsample = band;
          break;
        case 4: // Notch
          rsample = low + high;
          break;
        default:
      }

      // Panning & master volume
      t = (osc_sin(k * this.panFreq) * this.instr.fx_pan_amt) / 512 + 0.5;
      rsample *= 0.00476 * this.instr.env_master; // 39 / 8192 = 0.00476

      // Add to 16-bit channel buffer
      // k = k * 2;
      if (k < chnbufLength) {
        chnBuf.left[k] += rsample * (1 - t);
        chnBuf.right[k] += rsample * t;
      }
    }
  };

  SoundGenerator.prototype._createAudioBuffer = function(n, callBack) {
    const bufferSize =
      this.attack + this.sustain + this.release - 1 + 32 * this.rowLen;
    const buffer = generateBuffer(bufferSize);
    this._genSound(n, buffer, 0);
    applyDelay(buffer, bufferSize, this.instr, this.rowLen);

    callBack(getAudioBuffer(this.ctx, buffer));
  };

  const MusicGenerator = function(ctx, song) {
    this.ctx = ctx;
    this.song = song;
    // Wave data configuration
    this.waveSize = WAVE_SPS * song.songLen; // Total song size (in samples)
  };

  MusicGenerator.prototype._generateTrack = function(instr, mixBuf, callBack) {
    var self = this;
    var chnBuf = generateBuffer(this.waveSize);
    // Preload/precalc some properties/expressions (for improved performance)
    var waveSamples = self.waveSize,
      rowLen = self.song.rowLen,
      endPattern = self.song.endPattern,
      soundGen = new SoundGenerator(self.ctx, instr, rowLen);

    var currentpos = 0;
    var p = 0;
    var row = 0;
    var recordSounds = function() {
      var beginning = Date.now();
      while (true) {
        if (row === 32) {
          row = 0;
          p += 1;
          continue;
        }
        if (p === endPattern - 1) {
          return finalize();
        }
        var cp = instr.p[p];
        if (cp) {
          var n = instr.c[cp - 1].n[row];
          if (n) {
            soundGen._genSound(n, chnBuf, currentpos);
          }
        }
        currentpos += rowLen;
        row += 1;
        if (Date.now() - beginning > MAX_TIME) {
          setTimeout(recordSounds, 0);
          return;
        }
      }
    };

    var finalize = function() {
      applyDelay(chnBuf, waveSamples, instr, rowLen);
      for (var b2 = 0; b2 < waveSamples; b2++) {
        mixBuf.left[b2] += chnBuf.left[b2];
      }
      for (var b2 = 0; b2 < waveSamples; b2++) {
        mixBuf.right[b2] += chnBuf.right[b2];
      }
      callBack();
    };

    recordSounds();
  };

  MusicGenerator.prototype._createAudioBuffer = function(callBack) {
    var self = this;
    var mixBuf = generateBuffer(this.waveSize);
    var track = 0;

    var nextTrack = function() {
      if (track < self.song.songData.length) {
        track += 1;
        self._generateTrack(self.song.songData[track - 1], mixBuf, nextTrack);
      } else {
        callBack(getAudioBuffer(self.ctx, mixBuf));
      }
    };
    nextTrack();
  };

  sonantxrGenerateSong = function(audio_ctx, song_data, callback) {
    var music_generator = new MusicGenerator(audio_ctx, song_data);
    music_generator._createAudioBuffer(callback);
  };

  sonantxrGenerateSound = function(audio_ctx, instrument, note, callback) {
    var sound_generator = new SoundGenerator(audio_ctx, instrument);
    sound_generator._createAudioBuffer(note, callback);
  };
})();

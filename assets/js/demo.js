/* ==========================================================================
   Vyra site — local library demo.
   Files are read with the File API and decoded by the Web Audio API in this
   tab. Nothing is uploaded and no request is made.
   ========================================================================== */

(function () {
  'use strict';

  var app = document.getElementById('demo-app');
  if (!app) {
    return;
  }

  var AUDIO_EXT = /\.(mp3|wav|wave|flac|ogg|oga|m4a|aac|opus|aif|aiff|webm)$/i;
  var MAX_TRACKS = 200;
  var MAX_DECODE_BYTES = 48 * 1024 * 1024;
  var PEAK_BINS = 512;
  var MAX_TAG_BYTES = 512 * 1024;

  var els = {
    count: document.getElementById('demo-count'),
    message: document.getElementById('demo-message'),
    dropzone: document.getElementById('dropzone'),
    fileInput: document.getElementById('file-input'),
    folderInput: document.getElementById('folder-input'),
    search: document.getElementById('demo-search'),
    clear: document.getElementById('demo-clear'),
    table: document.getElementById('demo-table'),
    rows: document.getElementById('demo-rows'),
    empty: document.getElementById('demo-empty')
  };

  if (!els.dropzone || !els.table || !els.rows) {
    return;
  }

  var tracks = [];
  var nextId = 1;
  var audioContextRef = null;
  var decks = [];
  var EMPTY_LIBRARY = 'No tracks yet. Titles and artists come from ID3 tags when present, otherwise from the file name.';

  /* ---------- Helpers ---------- */

  function formatTime(seconds) {
    if (!isFinite(seconds) || seconds < 0) {
      return '00:00';
    }
    var total = Math.floor(seconds);
    var minutes = Math.floor(total / 60);
    var rest = total % 60;
    return (minutes < 10 ? '0' : '') + minutes + ':' + (rest < 10 ? '0' : '') + rest;
  }

  function isAudioFile(file) {
    return (file.type && file.type.indexOf('audio/') === 0) || AUDIO_EXT.test(file.name || '');
  }

  function setMessage(text, isError) {
    if (!els.message) {
      return;
    }
    els.message.textContent = text || '';
    els.message.classList.toggle('is-error', Boolean(isError));
  }

  function updateCount() {
    if (!els.count) {
      return;
    }
    var count = tracks.length;
    els.count.textContent = count === 0
      ? 'No tracks imported'
      : count + (count === 1 ? ' track imported' : ' tracks imported');
  }

  /* ---------- ID3v2 tags (MP3) ---------- */

  function readTags(file) {
    return new Promise(function (resolve) {
      var reader = new FileReader();
      reader.onload = function () {
        resolve(parseId3(reader.result));
      };
      reader.onerror = function () {
        resolve({});
      };
      reader.readAsArrayBuffer(file.slice(0, MAX_TAG_BYTES));
    });
  }

  function syncsafe(a, b, c, d) {
    return ((a & 0x7f) << 21) | ((b & 0x7f) << 14) | ((c & 0x7f) << 7) | (d & 0x7f);
  }

  function decodeText(bytes, encoding) {
    try {
      if (encoding === 0) {
        return new TextDecoder('windows-1252').decode(bytes);
      }
      if (encoding === 1) {
        if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
          return new TextDecoder('utf-16le').decode(bytes.subarray(2));
        }
        if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
          return new TextDecoder('utf-16be').decode(bytes.subarray(2));
        }
        return new TextDecoder('utf-16le').decode(bytes);
      }
      if (encoding === 2) {
        return new TextDecoder('utf-16be').decode(bytes);
      }
      return new TextDecoder('utf-8').decode(bytes);
    } catch (error) {
      return '';
    }
  }

  function cleanText(value) {
    return (value || '').replace(/\u0000+/g, ' ').replace(/\s+/g, ' ').trim();
  }

  function parseId3(buffer) {
    var out = {};
    if (!buffer || buffer.byteLength < 10) {
      return out;
    }
    var view = new DataView(buffer);
    if (view.getUint8(0) !== 0x49 || view.getUint8(1) !== 0x44 || view.getUint8(2) !== 0x33) {
      return out;
    }
    var version = view.getUint8(3);
    if (version < 3 || version > 4) {
      return out;
    }
    var headerFlags = view.getUint8(5);
    if (headerFlags & 0x80) {
      return out;
    }
    var tagSize = syncsafe(view.getUint8(6), view.getUint8(7), view.getUint8(8), view.getUint8(9));
    var end = Math.min(view.byteLength, 10 + tagSize);
    var offset = 10;
    var mapping = { TIT2: 'title', TPE1: 'artist', TALB: 'album', TCON: 'genre' };

    while (offset + 10 <= end) {
      var id = String.fromCharCode(
        view.getUint8(offset), view.getUint8(offset + 1),
        view.getUint8(offset + 2), view.getUint8(offset + 3)
      );
      if (!/^[A-Z0-9]{4}$/.test(id)) {
        break;
      }
      var size = version === 4
        ? syncsafe(view.getUint8(offset + 4), view.getUint8(offset + 5), view.getUint8(offset + 6), view.getUint8(offset + 7))
        : view.getUint32(offset + 4, false);
      if (size <= 0 || size > end - offset - 10) {
        break;
      }
      var field = mapping[id];
      if (field && !out[field]) {
        var bytes = new Uint8Array(buffer, offset + 10, size);
        var text = cleanText(decodeText(bytes.subarray(1), bytes[0]).split('\u0000')[0]);
        if (text) {
          out[field] = text;
        }
      }
      offset += 10 + size;
    }
    return out;
  }

  function fromFileName(name) {
    var base = (name || '').replace(/\.[^.]+$/, '').replace(/_/g, ' ');
    var parts = base.split(/\s+-\s+/);
    if (parts.length >= 2) {
      return { artist: parts[0].trim(), title: parts.slice(1).join(' - ').trim() };
    }
    return { artist: '', title: base.trim() };
  }

  /* ---------- Duration probe ---------- */

  function probeDuration(url) {
    return new Promise(function (resolve) {
      var audio = document.createElement('audio');
      var settled = false;
      var finish = function (ok, duration) {
        if (settled) {
          return;
        }
        settled = true;
        audio.removeAttribute('src');
        audio.load();
        resolve({ ok: ok, duration: ok ? duration : 0 });
      };
      audio.preload = 'metadata';
      audio.addEventListener('loadedmetadata', function () {
        finish(true, isFinite(audio.duration) ? audio.duration : 0);
      });
      audio.addEventListener('error', function () {
        finish(false, 0);
      });
      window.setTimeout(function () {
        finish(false, 0);
      }, 8000);
      audio.src = url;
    });
  }

  /* ---------- Waveform ---------- */

  function audioContext() {
    if (!audioContextRef) {
      var Ctor = window.AudioContext || window.webkitAudioContext;
      if (!Ctor) {
        return null;
      }
      audioContextRef = new Ctor();
    }
    if (audioContextRef.state === 'suspended' && audioContextRef.resume) {
      audioContextRef.resume();
    }
    return audioContextRef;
  }

  function decodeFile(file) {
    var context = audioContext();
    if (!context) {
      return Promise.reject(new Error('Web Audio unavailable'));
    }
    return file.arrayBuffer().then(function (buffer) {
      return new Promise(function (resolve, reject) {
        var settled = false;
        var ok = function (decoded) {
          if (!settled) {
            settled = true;
            resolve(decoded);
          }
        };
        var fail = function (error) {
          if (!settled) {
            settled = true;
            reject(error || new Error('decode failed'));
          }
        };
        var pending = context.decodeAudioData(buffer, ok, fail);
        if (pending && typeof pending.then === 'function') {
          pending.then(ok, fail);
        }
      });
    });
  }

  function peaksFrom(buffer, bins) {
    var channels = Math.min(buffer.numberOfChannels, 2);
    var data = [];
    for (var c = 0; c < channels; c++) {
      data.push(buffer.getChannelData(c));
    }
    var length = buffer.length;
    var step = Math.max(1, Math.floor(length / bins));
    var peaks = new Float32Array(bins);
    var loudest = 0;

    for (var i = 0; i < bins; i++) {
      var start = i * step;
      var end = Math.min(length, start + step);
      var stride = Math.max(1, Math.floor((end - start) / 96));
      var peak = 0;
      for (var ch = 0; ch < data.length; ch++) {
        var samples = data[ch];
        for (var j = start; j < end; j += stride) {
          var value = samples[j] < 0 ? -samples[j] : samples[j];
          if (value > peak) {
            peak = value;
          }
        }
      }
      peaks[i] = peak;
      if (peak > loudest) {
        loudest = peak;
      }
    }
    if (loudest > 0) {
      for (var k = 0; k < bins; k++) {
        peaks[k] = peaks[k] / loudest;
      }
    }
    return peaks;
  }

  function drawWave(deck) {
    var canvas = deck.wave;
    if (!canvas || !canvas.getContext) {
      return;
    }
    var rect = canvas.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) {
      return;
    }
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    var width = Math.max(1, Math.round(rect.width * dpr));
    var height = Math.max(1, Math.round(rect.height * dpr));
    if (canvas.width !== width) {
      canvas.width = width;
    }
    if (canvas.height !== height) {
      canvas.height = height;
    }

    var context = canvas.getContext('2d');
    context.clearRect(0, 0, width, height);
    if (!deck.peaks) {
      return;
    }

    var middle = height / 2;
    var bins = deck.peaks.length;
    var bar = width / bins;
    var gradient = context.createLinearGradient(0, 0, 0, height);
    gradient.addColorStop(0, 'rgba(101, 236, 198, 0.95)');
    gradient.addColorStop(0.5, 'rgba(71, 215, 176, 0.85)');
    gradient.addColorStop(1, 'rgba(71, 215, 176, 0.3)');
    context.fillStyle = gradient;

    for (var i = 0; i < bins; i++) {
      var amplitude = Math.max(0.02, deck.peaks[i]) * (middle - 2 * dpr);
      var x = i * bar + bar * 0.15;
      var w = Math.max(dpr, bar * 0.7);
      context.fillRect(x, middle - amplitude, w, amplitude * 2);
    }

    context.fillStyle = 'rgba(232, 255, 247, 0.16)';
    context.fillRect(0, middle - dpr / 2, width, Math.max(1, dpr));

    if (deck.duration > 0 && deck.progress > 0.001) {
      context.fillStyle = 'rgba(237, 242, 244, 0.92)';
      context.fillRect(Math.min(width - dpr, deck.progress * width), 0, Math.max(1, dpr), height);
    }
  }

  /* ---------- Deck state ---------- */

  function setDeckStatus(deck, text, isError) {
    deck.statusEl.textContent = text;
    deck.statusEl.classList.toggle('is-error', Boolean(isError));
  }

  function syncSlider(deck) {
    var canvas = deck.wave;
    var duration = deck.duration || (deck.audio && isFinite(deck.audio.duration) ? deck.audio.duration : 0);
    canvas.setAttribute('aria-valuemin', '0');
    canvas.setAttribute('aria-valuemax', duration ? Math.round(duration).toString() : '0');
    canvas.setAttribute('aria-valuenow', deck.audio ? Math.round(deck.audio.currentTime).toString() : '0');
    canvas.setAttribute('aria-valuetext', deck.track
      ? formatTime(deck.audio ? deck.audio.currentTime : 0) + ' of ' + formatTime(duration)
      : 'No track loaded');
  }

  function startTicker(deck) {
    if (deck.raf) {
      return;
    }
    var step = function () {
      if (!deck.audio) {
        deck.raf = 0;
        return;
      }
      var duration = deck.audio.duration || deck.duration;
      deck.progress = duration ? Math.min(1, deck.audio.currentTime / duration) : 0;
      deck.timeEl.textContent = formatTime(deck.audio.currentTime);
      syncSlider(deck);
      drawWave(deck);
      deck.raf = deck.audio.paused ? 0 : window.requestAnimationFrame(step);
    };
    deck.raf = window.requestAnimationFrame(step);
  }

  function stopTicker(deck) {
    if (deck.raf) {
      window.cancelAnimationFrame(deck.raf);
      deck.raf = 0;
    }
  }

  function resetDeck(deck) {
    deck.token++;
    stopTicker(deck);
    if (deck.audio) {
      deck.audio.pause();
      deck.audio.removeAttribute('src');
      deck.audio.load();
      deck.audio = null;
    }
    deck.track = null;
    deck.peaks = null;
    deck.progress = 0;
    deck.duration = 0;
    deck.trackEl.textContent = 'Nothing loaded';
    deck.trackEl.removeAttribute('title');
    deck.timeEl.textContent = '00:00';
    deck.playBtn.textContent = 'Play';
    deck.playBtn.disabled = true;
    deck.ejectBtn.disabled = true;
    deck.wave.classList.remove('is-ready');
    deck.wave.tabIndex = -1;
    deck.wave.setAttribute('aria-disabled', 'true');
    syncSlider(deck);
    setDeckStatus(deck, 'Empty');
    drawWave(deck);
  }

  function attachAudio(deck, track) {
    var audio = new Audio();
    audio.preload = 'metadata';
    audio.src = track.url;
    deck.audio = audio;

    audio.addEventListener('play', function () {
      deck.playBtn.textContent = 'Pause';
      deck.playBtn.setAttribute('aria-label', 'Pause ' + track.title + ' on deck ' + deck.label);
      startTicker(deck);
    });
    audio.addEventListener('pause', function () {
      deck.playBtn.textContent = 'Play';
      deck.playBtn.setAttribute('aria-label', 'Play ' + track.title + ' on deck ' + deck.label);
    });
    audio.addEventListener('ended', function () {
      deck.progress = 0;
      deck.timeEl.textContent = '00:00';
      syncSlider(deck);
      drawWave(deck);
    });
    audio.addEventListener('error', function () {
      setDeckStatus(deck, 'Playback failed in this browser', true);
      deck.playBtn.disabled = true;
    });

    deck.playBtn.disabled = false;
    deck.playBtn.textContent = 'Play';
    deck.playBtn.setAttribute('aria-label', 'Play ' + track.title + ' on deck ' + deck.label);
    deck.wave.tabIndex = 0;
    deck.wave.setAttribute('aria-disabled', 'false');
    deck.wave.classList.add('is-ready');
  }

  function loadTrack(index, id) {
    var deck = decks[index];
    var track = null;
    for (var i = 0; i < tracks.length; i++) {
      if (tracks[i].id === id) {
        track = tracks[i];
        break;
      }
    }
    if (!deck || !track) {
      return;
    }

    resetDeck(deck);
    var token = deck.token;
    deck.track = track;
    deck.trackEl.textContent = track.title + (track.artist ? ' — ' + track.artist : '');
    deck.trackEl.title = track.file.name;
    deck.ejectBtn.disabled = false;

    if (track.file.size > MAX_DECODE_BYTES) {
      attachAudio(deck, track);
      setDeckStatus(deck, 'Waveform skipped — file over 48 MB');
      syncSlider(deck);
      setMessage('Loaded “' + track.title + '” into deck ' + deck.label + '. Waveform skipped for this large file.');
      return;
    }

    setDeckStatus(deck, 'Decoding locally…');
    setMessage('Decoding “' + track.title + '” in this tab…');

    decodeFile(track.file).then(function (buffer) {
      if (deck.token !== token) {
        return;
      }
      deck.duration = buffer.duration;
      deck.peaks = peaksFrom(buffer, PEAK_BINS);
      setDeckStatus(deck, formatTime(buffer.duration) + ' · ' + (buffer.numberOfChannels > 1 ? 'stereo' : 'mono') + ' · waveform');
      attachAudio(deck, track);
      syncSlider(deck);
      drawWave(deck);
      setMessage('Loaded “' + track.title + '” into deck ' + deck.label + ' with a locally generated waveform.');
    }).catch(function () {
      if (deck.token !== token) {
        return;
      }
      deck.peaks = null;
      drawWave(deck);
      setDeckStatus(deck, 'This browser cannot decode this file', true);
      setMessage('“' + track.file.name + '” could not be decoded by this browser.', true);
    });
  }

  function togglePlay(deck) {
    if (!deck.audio) {
      return;
    }
    if (deck.audio.paused) {
      var playing = deck.audio.play();
      if (playing && typeof playing.catch === 'function') {
        playing.catch(function () {
          setDeckStatus(deck, 'Playback was blocked by the browser', true);
        });
      }
    } else {
      deck.audio.pause();
    }
  }

  function seekTo(deck, seconds) {
    if (!deck.audio || !isFinite(deck.audio.duration)) {
      return;
    }
    deck.audio.currentTime = Math.min(deck.audio.duration, Math.max(0, seconds));
    deck.progress = deck.audio.duration ? deck.audio.currentTime / deck.audio.duration : 0;
    deck.timeEl.textContent = formatTime(deck.audio.currentTime);
    syncSlider(deck);
    drawWave(deck);
  }

  Array.prototype.forEach.call(app.querySelectorAll('.demo-deck'), function (el, index) {
    var deck = {
      index: index,
      label: index === 0 ? '01' : '02',
      wave: el.querySelector('[data-role="wave"]'),
      statusEl: el.querySelector('[data-role="status"]'),
      trackEl: el.querySelector('[data-role="track"]'),
      timeEl: el.querySelector('[data-role="time"]'),
      playBtn: el.querySelector('[data-role="play"]'),
      ejectBtn: el.querySelector('[data-role="eject"]'),
      audio: null,
      peaks: null,
      progress: 0,
      duration: 0,
      raf: 0,
      token: 0,
      track: null
    };
    deck.wave.setAttribute('aria-label', 'Deck ' + deck.label + ' waveform');

    deck.wave.addEventListener('click', function (event) {
      if (!deck.audio || !deck.duration) {
        return;
      }
      var rect = deck.wave.getBoundingClientRect();
      var fraction = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
      seekTo(deck, fraction * deck.audio.duration);
    });

    deck.wave.addEventListener('keydown', function (event) {
      if (!deck.audio || !isFinite(deck.audio.duration)) {
        return;
      }
      var handled = true;
      if (event.key === 'ArrowRight') {
        seekTo(deck, deck.audio.currentTime + 5);
      } else if (event.key === 'ArrowLeft') {
        seekTo(deck, deck.audio.currentTime - 5);
      } else if (event.key === 'Home') {
        seekTo(deck, 0);
      } else if (event.key === 'End') {
        seekTo(deck, deck.audio.duration - 0.2);
      } else {
        handled = false;
      }
      if (handled) {
        event.preventDefault();
      }
    });

    deck.playBtn.addEventListener('click', function () {
      togglePlay(deck);
    });
    deck.ejectBtn.addEventListener('click', function () {
      resetDeck(deck);
      setMessage('Deck ' + deck.label + ' cleared.');
    });

    decks.push(deck);
    resetDeck(deck);
  });

  /* ---------- Library table ---------- */

  function applyFilter() {
    var query = (els.search && els.search.value ? els.search.value : '').trim().toLowerCase();
    var visible = 0;
    Array.prototype.forEach.call(els.rows.children, function (row) {
      var haystack = row.getAttribute('data-search') || '';
      var match = !query || haystack.indexOf(query) !== -1;
      row.hidden = !match;
      if (match) {
        visible++;
      }
    });

    if (tracks.length === 0) {
      els.table.hidden = true;
      els.empty.hidden = false;
      els.empty.textContent = EMPTY_LIBRARY;
      return;
    }
    if (visible === 0) {
      els.table.hidden = true;
      els.empty.hidden = false;
      els.empty.textContent = 'No imported track matches this search.';
      return;
    }
    els.table.hidden = false;
    els.empty.hidden = true;
  }

  function pickButton(deckIndex, track) {
    var button = document.createElement('button');
    button.type = 'button';
    button.className = 'deckpick';
    button.setAttribute('data-deck', deckIndex === 0 ? '0' : '1');
    button.textContent = deckIndex === 0 ? '01' : '02';
    button.setAttribute('aria-label', 'Load ' + track.title + ' into deck ' + (deckIndex === 0 ? '01' : '02'));
    return button;
  }

  function renderRows() {
    var fragment = document.createDocumentFragment();

    tracks.forEach(function (track) {
      var row = document.createElement('tr');
      row.className = 'demo__row';
      row.setAttribute('data-id', String(track.id));
      row.setAttribute('data-search', (track.title + ' ' + track.artist + ' ' + track.album + ' ' + track.file.name).toLowerCase());

      var titleCell = document.createElement('td');
      var name = document.createElement('span');
      name.className = 'demo__trackname';
      name.textContent = track.title;
      name.title = track.file.name;
      titleCell.appendChild(name);

      var artistCell = document.createElement('td');
      artistCell.className = 'col-artist';
      artistCell.textContent = track.artist || '—';

      var albumCell = document.createElement('td');
      albumCell.className = 'col-album';
      albumCell.textContent = track.album || '—';

      var durationCell = document.createElement('td');
      durationCell.className = 'col-dur';
      durationCell.textContent = track.duration ? formatTime(track.duration) : '--:--';

      var pickCell = document.createElement('td');
      pickCell.className = 'col-pick';
      pickCell.appendChild(pickButton(0, track));
      pickCell.appendChild(pickButton(1, track));

      row.appendChild(titleCell);
      row.appendChild(artistCell);
      row.appendChild(albumCell);
      row.appendChild(durationCell);
      row.appendChild(pickCell);
      fragment.appendChild(row);
    });

    els.rows.textContent = '';
    els.rows.appendChild(fragment);
    els.clear.disabled = tracks.length === 0;
    updateCount();
    applyFilter();
  }

  /* ---------- Import ---------- */

  function filesFromDataTransfer(dataTransfer) {
    var items = dataTransfer && dataTransfer.items ? Array.prototype.slice.call(dataTransfer.items) : [];
    var entries = [];
    items.forEach(function (item) {
      if (item.kind !== 'file' || typeof item.webkitGetAsEntry !== 'function') {
        return;
      }
      var entry = item.webkitGetAsEntry();
      if (entry) {
        entries.push(entry);
      }
    });

    if (!entries.length) {
      return Promise.resolve(dataTransfer && dataTransfer.files ? Array.prototype.slice.call(dataTransfer.files) : []);
    }

    var files = [];
    var walk = function (entry) {
      if (entry.isFile) {
        return new Promise(function (resolve) {
          entry.file(function (file) {
            files.push(file);
            resolve();
          }, function () {
            resolve();
          });
        });
      }
      if (entry.isDirectory) {
        var reader = entry.createReader();
        var readBatch = function () {
          return new Promise(function (resolve) {
            reader.readEntries(resolve, function () {
              resolve([]);
            });
          });
        };
        var next = function (batch) {
          if (!batch.length) {
            return Promise.resolve();
          }
          return batch.reduce(function (chain, child) {
            return chain.then(function () {
              return walk(child);
            });
          }, Promise.resolve()).then(readBatch).then(next);
        };
        return readBatch().then(next);
      }
      return Promise.resolve();
    };

    return entries.reduce(function (chain, entry) {
      return chain.then(function () {
        return walk(entry);
      });
    }, Promise.resolve()).then(function () {
      return files;
    });
  }

  function addFiles(fileList) {
    var incoming = Array.prototype.slice.call(fileList || []).filter(isAudioFile);
    if (!incoming.length) {
      setMessage('No audio files found in that selection.', true);
      return Promise.resolve();
    }

    var pending = incoming.slice(0, Math.max(0, MAX_TRACKS - tracks.length));
    var rejected = incoming.length - pending.length;
    setMessage('Reading ' + pending.length + (pending.length === 1 ? ' file…' : ' files…'));

    var chain = Promise.resolve();
    var added = 0;

    pending.forEach(function (file) {
      chain = chain.then(function () {
        var duplicate = tracks.some(function (track) {
          return track.file.name === file.name
            && track.file.size === file.size
            && track.file.lastModified === file.lastModified;
        });
        if (duplicate) {
          return null;
        }
        return readTags(file).then(function (tags) {
          var fallback = fromFileName(file.name);
          var url = URL.createObjectURL(file);
          return probeDuration(url).then(function (probe) {
            tracks.push({
              id: nextId++,
              file: file,
              url: url,
              title: (tags.title || fallback.title || file.name).slice(0, 160),
              artist: (tags.artist || fallback.artist || '').slice(0, 120),
              album: (tags.album || '').slice(0, 120),
              duration: probe.duration,
              playable: probe.ok
            });
            added++;
            renderRows();
          });
        });
      });
    });

    return chain.then(function () {
      var parts = [];
      if (added) {
        parts.push('Imported ' + added + (added === 1 ? ' track' : ' tracks') + '.');
      }
      if (rejected) {
        parts.push(rejected + ' skipped: the demo holds ' + MAX_TRACKS + ' tracks.');
      }
      if (!added) {
        parts.push('Those files are already in the library.');
      }
      setMessage(parts.join(' ') || 'Nothing to import.');
    });
  }

  /* ---------- Wiring ---------- */

  if (els.fileInput) {
    els.fileInput.addEventListener('change', function () {
      addFiles(els.fileInput.files).then(function () {
        els.fileInput.value = '';
      });
    });
  }

  if (els.folderInput) {
    els.folderInput.addEventListener('change', function () {
      addFiles(els.folderInput.files).then(function () {
        els.folderInput.value = '';
      });
    });
  }

  var pickFiles = document.getElementById('pick-files');
  if (pickFiles && els.fileInput) {
    pickFiles.addEventListener('click', function () {
      els.fileInput.click();
    });
  }

  var pickFolder = document.getElementById('pick-folder');
  if (pickFolder && els.folderInput) {
    pickFolder.addEventListener('click', function () {
      els.folderInput.click();
    });
  }

  ['dragenter', 'dragover'].forEach(function (type) {
    els.dropzone.addEventListener(type, function (event) {
      event.preventDefault();
      event.stopPropagation();
      els.dropzone.classList.add('is-dragging');
    });
  });

  ['dragleave', 'dragend'].forEach(function (type) {
    els.dropzone.addEventListener(type, function (event) {
      event.preventDefault();
      els.dropzone.classList.remove('is-dragging');
    });
  });

  els.dropzone.addEventListener('drop', function (event) {
    event.preventDefault();
    event.stopPropagation();
    els.dropzone.classList.remove('is-dragging');
    filesFromDataTransfer(event.dataTransfer).then(addFiles);
  });

  window.addEventListener('dragover', function (event) {
    event.preventDefault();
  });

  window.addEventListener('drop', function (event) {
    if (!els.dropzone.contains(event.target)) {
      event.preventDefault();
    }
  });

  if (els.search) {
    els.search.addEventListener('input', applyFilter);
  }

  if (els.clear) {
    els.clear.addEventListener('click', function () {
      tracks.forEach(function (track) {
        URL.revokeObjectURL(track.url);
      });
      tracks = [];
      decks.forEach(resetDeck);
      renderRows();
      if (els.search) {
        els.search.value = '';
      }
      setMessage('Library cleared. Nothing was stored.');
    });
  }

  els.rows.addEventListener('click', function (event) {
    var button = event.target.closest ? event.target.closest('.deckpick') : null;
    if (!button) {
      return;
    }
    var row = button.closest('tr');
    if (!row) {
      return;
    }
    loadTrack(button.getAttribute('data-deck') === '1' ? 1 : 0, Number(row.getAttribute('data-id')));
  });

  if (window.ResizeObserver) {
    var observer = new ResizeObserver(function () {
      decks.forEach(drawWave);
    });
    observer.observe(app);
  } else {
    window.addEventListener('resize', function () {
      decks.forEach(drawWave);
    });
  }

  window.addEventListener('beforeunload', function () {
    tracks.forEach(function (track) {
      URL.revokeObjectURL(track.url);
    });
  });

  renderRows();
  setMessage('Nothing leaves this tab — pick a folder to begin.');
})();

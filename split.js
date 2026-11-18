/*
 * split.js
 *
 * Big Unity WebGL build files (*.unityweb) are stored cut into 19 MB parts so no
 * single file exceeds GitHub/jsDelivr limits. This file does two jobs:
 *
 *  1. Node CLI - cuts files > 20 MB into 19 MB parts and writes split-manifest.json
 *
 *        node split.js            split files > 20 MB & index existing .part* sets
 *        node split.js restore    put the original files back and remove the parts
 *
 *  2. Browser shim - included by index.html before the Unity loader. It patches
 *     fetch (and XMLHttpRequest) so a request for Build/1234.data.unityweb is
 *     answered with a single streaming Response that is the parts concatenated
 *     in order.
 */
(function () {
  "use strict";

  var CHUNK_SIZE = 19 * 1024 * 1024; // 19 MB
  var THRESHOLD = 20 * 1024 * 1024;  // files bigger than 20 MB get split
  var MANIFEST_NAME = "split-manifest.json";
  var READ_AHEAD = 38 * 1024 * 1024; // keep up to 2 chunks buffered ahead

  /* ------------------------------------------------------------------ */
  /* Node side: split / restore                                          */
  /* ------------------------------------------------------------------ */

  function runCli(argv) {
    var fs = require("fs");
    var path = require("path");
    var crypto = require("crypto");

    var root = __dirname;
    var manifestPath = path.join(root, MANIFEST_NAME);
    var command = String(argv[0] || "split").toLowerCase();

    function abs(rel) {
      return path.join(root, rel);
    }

    function pad(index, width) {
      var text = String(index);
      while (text.length < width) text = "0" + text;
      return text;
    }

    function megabytes(bytes) {
      return (bytes / (1024 * 1024)).toFixed(1) + " MB";
    }

    var SKIP_DIRS = { ".git": 1, node_modules: 1, ".freebuff": 1 };

    function walk(dir, out) {
      var entries = fs.readdirSync(dir, { withFileTypes: true });
      for (var i = 0; i < entries.length; i++) {
        var entry = entries[i];
        var full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (!SKIP_DIRS[entry.name]) walk(full, out);
        } else if (entry.isFile()) {
          out.push(path.relative(root, full).split(path.sep).join("/"));
        }
      }
      return out;
    }

    function readExact(handle, buffer, length, position) {
      var done = 0;
      while (done < length) {
        var read = fs.readSync(handle, buffer, done, length - done, position + done);
        if (read === 0) throw new Error("unexpected end of file");
        done += read;
      }
    }

    function indexMap(chunks) {
      var list = {};
      for (var i = 0; i < chunks; i++) list[i] = true;
      return list;
    }

    function splitOne(rel, families) {
      var file = abs(rel);
      var size = fs.statSync(file).size;
      var chunks = Math.ceil(size / CHUNK_SIZE);
      var digits = 0; // unpadded: .part0, .part1, ...

      process.stdout.write("  " + rel + " (" + megabytes(size) + ") -> " + chunks + " parts ... ");

      var original = crypto.createHash("sha256");
      var buffer = Buffer.allocUnsafe(CHUNK_SIZE);
      var position = 0;
      var handle = fs.openSync(file, "r");
      try {
        for (var i = 0; i < chunks; i++) {
          var length = Math.min(CHUNK_SIZE, size - position);
          readExact(handle, buffer, length, position);
          var slice = buffer.subarray(0, length);
          original.update(slice);
          fs.writeFileSync(file + ".part" + pad(i, digits), slice);
          position += length;
        }
      } finally {
        fs.closeSync(handle);
      }

      var expected = original.digest("hex");
      var rebuilt = crypto.createHash("sha256");
      for (var j = 0; j < chunks; j++) {
        rebuilt.update(fs.readFileSync(file + ".part" + pad(j, digits)));
      }
      if (rebuilt.digest("hex") !== expected) {
        throw new Error("verification failed for " + rel + "; original left untouched");
      }

      fs.unlinkSync(file);
      families[rel] = { parts: indexMap(chunks), size: size, sha256: expected, digits: digits };
      console.log("ok");
    }

    function splitAll() {
      var previous = {};
      if (fs.existsSync(manifestPath)) {
        try {
          previous = JSON.parse(fs.readFileSync(manifestPath, "utf8")).files || {};
        } catch (error) {
          previous = {};
        }
      }

      var files = walk(root, []);
      var families = {};
      var big = [];

      for (var i = 0; i < files.length; i++) {
        var rel = files[i];
        var match = /^(.*)\.part(\d+)$/.exec(rel);
        if (match) {
          var base = match[1];
          var rawDigits = match[2];
          var index = Number(rawDigits);
          var family = families[base] || (families[base] = {
            parts: {},
            size: 0,
            sha256: null,
            padded: false,
            digits: 0
          });
          family.parts[index] = true;
          family.size += fs.statSync(abs(rel)).size;
          // Detect leading-zero padding (e.g. "00" or "01") vs unpadded ("0", "1", "10")
          if (rawDigits.length > 1 && rawDigits.charAt(0) === "0") {
            family.padded = true;
            family.digits = Math.max(family.digits, rawDigits.length);
          } else if (family.padded) {
            family.digits = Math.max(family.digits, rawDigits.length);
          }
          continue;
        }
        if (fs.statSync(abs(rel)).size > THRESHOLD) big.push(rel);
      }

      var already = Object.keys(families).length;

      if (!big.length) {
        console.log("No unsplit file is bigger than " + megabytes(THRESHOLD) + ".");
      } else {
        console.log("Splitting " + big.length + " file(s) into " + megabytes(CHUNK_SIZE) + " parts:");
        for (var k = 0; k < big.length; k++) splitOne(big[k], families);
      }

      if (already) {
        console.log("Indexed " + already + " pre-split file(s) into the manifest.");
      }

      var manifest = {
        version: 1,
        chunkSize: CHUNK_SIZE,
        threshold: THRESHOLD,
        generatedAt: new Date().toISOString(),
        files: {}
      };
      var bases = Object.keys(families).sort();
      var parts = 0;
      for (var b = 0; b < bases.length; b++) {
        var name = bases[b];
        var entry = families[name];
        var indexes = Object.keys(entry.parts)
          .map(Number)
          .sort(function (x, y) {
            return x - y;
          });
        parts += indexes.length;
        var known = previous[name];
        manifest.files[name] = {
          base: name,
          size: entry.size,
          chunks: indexes.length,
          digits: entry.padded ? entry.digits : 0,
          sha256: entry.sha256 || (known && known.size === entry.size ? known.sha256 : null)
        };
      }

      if (!bases.length) {
        console.log("Nothing to record in " + MANIFEST_NAME + ".");
        return;
      }

      fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
      console.log("Wrote " + MANIFEST_NAME + ": " + bases.length + " file(s), " + parts + " part(s).");
    }

    function restoreAll() {
      if (!fs.existsSync(manifestPath)) throw new Error(MANIFEST_NAME + " not found; nothing to restore.");
      var manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
      var bases = Object.keys(manifest.files || {});

      for (var i = 0; i < bases.length; i++) {
        var base = bases[i];
        var entry = manifest.files[base];
        var file = abs(base);
        if (fs.existsSync(file)) {
          console.log("  " + base + " already exists; skipping");
          continue;
        }
        var hash = crypto.createHash("sha256");
        var out = fs.openSync(file, "w");
        try {
          for (var p = 0; p < entry.chunks; p++) {
            var part = fs.readFileSync(file + ".part" + pad(p, entry.digits || 0));
            hash.update(part);
            fs.writeSync(out, part);
          }
        } finally {
          fs.closeSync(out);
        }
        if (entry.sha256 && hash.digest("hex") !== entry.sha256) {
          fs.unlinkSync(file);
          throw new Error("restored " + base + " does not match its recorded hash");
        }
        for (var q = 0; q < entry.chunks; q++) fs.unlinkSync(file + ".part" + pad(q, entry.digits || 0));
        console.log("  restored " + base + " (" + megabytes(entry.size) + ")");
      }

      fs.unlinkSync(manifestPath);
      console.log("Removed " + MANIFEST_NAME + ". Files are whole again.");
    }

    if (command === "split" || command === "build" || command === "all") {
      splitAll();
    } else if (command === "restore" || command === "join" || command === "unsplit") {
      restoreAll();
    } else {
      console.error("Usage: node split.js [split|restore]");
      process.exitCode = 1;
    }
  }

  /* ------------------------------------------------------------------ */
  /* Browser side: serve the parts as one response                       */
  /* ------------------------------------------------------------------ */

  function installBrowserShim(W) {
    if (W.__unitySplitShimInstalled) return;
    W.__unitySplitShimInstalled = true;

    var nativeFetch = typeof W.fetch === "function" ? W.fetch.bind(W) : null;
    if (!nativeFetch) return;

    function pageBase() {
      return (W.document && W.document.baseURI) || W.location.href;
    }

    var manifestUrl = new W.URL(MANIFEST_NAME, pageBase()).href;
    var manifestPromise = nativeFetch(manifestUrl, { cache: "no-store" })
      .then(function (response) {
        if (!response.ok) {
          console.warn("split.js: " + MANIFEST_NAME + " returned HTTP " + response.status + "; serving files as-is.");
          return null;
        }
        return response.json();
      })
      .catch(function (error) {
        console.warn("split.js: could not read " + MANIFEST_NAME + " (" + error + "); serving files as-is.");
        return null;
      });

    function pad(index, width) {
      var text = String(index);
      while (text.length < width) text = "0" + text;
      return text;
    }

    function chunkUrl(entry, index) {
      return new W.URL(entry.base + ".part" + pad(index, entry.digits || 0), pageBase()).href;
    }

    function findEntry(data, url) {
      if (!data || !data.files || url == null) return null;
      var pathname;
      try {
        pathname = decodeURIComponent(new W.URL(String(url), pageBase()).pathname);
      } catch (error) {
        return null;
      }
      var bases = Object.keys(data.files);
      for (var i = 0; i < bases.length; i++) {
        var tail = "/" + bases[i];
        if (pathname === tail || pathname.slice(-tail.length) === tail) return data.files[bases[i]];
      }
      return null;
    }

    function fetchChunk(entry, index, init) {
      var options = { credentials: (init && init.credentials) || "same-origin" };
      if (init && init.signal) options.signal = init.signal;
      var url = chunkUrl(entry, index);
      return nativeFetch(url, options).then(function (response) {
        if (!response.ok) {
          throw new Error("split.js: " + url + " returned HTTP " + response.status + ". Re-run `node split.js` to rebuild the parts.");
        }
        return response.arrayBuffer();
      });
    }

    function isWasm(binary) {
      var head = new Uint8Array(binary, 0, Math.min(4, binary.byteLength));
      return head.length === 4 && head[0] === 0x00 && head[1] === 0x61 && head[2] === 0x73 && head[3] === 0x6d;
    }

    function createBody(entry, init, firstChunk) {
      var nextIndex = 1;
      var current = Promise.resolve(firstChunk);
      var ahead = entry.chunks > 1 ? fetchChunk(entry, 1, init) : null;
      var strategy = W.ByteLengthQueuingStrategy
        ? new W.ByteLengthQueuingStrategy({ highWaterMark: READ_AHEAD })
        : { highWaterMark: 2 };

      return new W.ReadableStream(
        {
          pull: function (controller) {
            var promise = current || Promise.resolve(null);
            return promise.then(function (binary) {
              if (!binary) {
                controller.close();
                return;
              }
              current = ahead || (nextIndex < entry.chunks ? fetchChunk(entry, nextIndex, init) : null);
              ahead = nextIndex + 1 < entry.chunks ? fetchChunk(entry, nextIndex + 1, init) : null;
              nextIndex += 1;
              controller.enqueue(new Uint8Array(binary));
            });
          },
          cancel: function () {
            current = null;
            ahead = null;
          }
        },
        strategy
      );
    }

    function splitResponse(entry, init) {
      return fetchChunk(entry, 0, init).then(function (firstChunk) {
        if (!firstChunk) throw new Error("split.js: no parts for " + entry.base);
        var headers = {
          "Content-Type": isWasm(firstChunk) ? "application/wasm" : "application/octet-stream",
          "Content-Length": String(entry.size)
        };
        return new W.Response(createBody(entry, init, firstChunk), {
          status: 200,
          statusText: "OK",
          headers: headers
        });
      });
    }

    W.fetch = function (input, init) {
      var method = String((init && init.method) || (input && input.method) || "GET").toUpperCase();
      if (method !== "GET" && method !== "HEAD") return nativeFetch(input, init);

      var url = typeof input === "string"
        ? input
        : input && typeof input.url === "string"
          ? input.url
          : String(input);

      return manifestPromise.then(function (data) {
        var entry = findEntry(data, url);
        if (!entry) return nativeFetch(input, init);
        if (method === "HEAD") {
          return new W.Response(null, { status: 200, headers: { "Content-Length": String(entry.size) } });
        }
        return splitResponse(entry, init);
      });
    };

    var XHR = W.XMLHttpRequest;
    if (XHR && XHR.prototype) {
      var nativeOpen = XHR.prototype.open;
      var nativeSend = XHR.prototype.send;

      XHR.prototype.open = function (method, url) {
        this.__splitMethod = String(method || "GET").toUpperCase();
        this.__splitUrl = url;
        return nativeOpen.apply(this, arguments);
      };

      XHR.prototype.send = function () {
        var xhr = this;
        var args = arguments;
        if ((xhr.__splitMethod !== "GET" && xhr.__splitMethod !== "HEAD") || !xhr.__splitUrl) {
          return nativeSend.apply(xhr, args);
        }

        manifestPromise.then(function (data) {
          var entry = findEntry(data, xhr.__splitUrl);
          if (!entry) {
            nativeSend.apply(xhr, args);
            return;
          }
          if (xhr.__splitMethod === "HEAD") {
            finishHeadXhr(W, xhr, entry, xhr.__splitUrl);
            return;
          }
          assembleViaXhr(W, xhr, entry, fetchChunk, xhr.__splitUrl);
        });
      };
    }

    W.__unitySplit = {
      manifest: manifestPromise,
      chunkUrl: chunkUrl
    };
  }

  function setXhrProp(xhr, name, value) {
    try {
      Object.defineProperty(xhr, name, { configurable: true, value: value });
    } catch (error) {
      try {
        xhr[name] = value;
      } catch (ignored) {}
    }
  }

  function fireXhrEvent(W, xhr, name, props) {
    var event;
    try {
      event = new W.ProgressEvent(name, props || {});
    } catch (error) {
      try {
        event = new W.Event(name);
      } catch (ignored) {
        return;
      }
    }
    try {
      xhr.dispatchEvent(event);
    } catch (ignored) {}
  }

  function finishHeadXhr(W, xhr, entry, url) {
    xhr.getResponseHeader = function (header) {
      return String(header || "").toLowerCase() === "content-length" ? String(entry.size) : null;
    };
    xhr.getAllResponseHeaders = function () {
      return "content-length: " + entry.size + "\r\n";
    };
    setXhrProp(xhr, "status", 200);
    setXhrProp(xhr, "statusText", "OK");
    setXhrProp(xhr, "responseURL", url);
    setXhrProp(xhr, "readyState", 4);
    fireXhrEvent(W, xhr, "readystatechange", {});
    fireXhrEvent(W, xhr, "load", {});
    fireXhrEvent(W, xhr, "loadend", {});
  }

  function assembleViaXhr(W, xhr, entry, fetchChunk, url) {
    var buffer = new Uint8Array(entry.size);
    var received = 0;

    var chain = Promise.resolve();
    for (var i = 0; i < entry.chunks; i++) {
      (function (index) {
        chain = chain
          .then(function () {
            return fetchChunk(entry, index, null);
          })
          .then(function (binary) {
            buffer.set(new Uint8Array(binary), received);
            received += binary.byteLength;
            setXhrProp(xhr, "readyState", 3);
            fireXhrEvent(W, xhr, "readystatechange", { loaded: received, total: entry.size, lengthComputable: true });
            fireXhrEvent(W, xhr, "progress", { loaded: received, total: entry.size, lengthComputable: true });
          });
      })(i);
    }

    chain.then(function () {
      var type = String(xhr.responseType || "");
      var body = buffer.subarray(0, received);
      var response;
      if (type === "arraybuffer") {
        response = body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength);
      } else if (type === "blob") {
        response = new W.Blob([body]);
      } else if (type === "json") {
        response = JSON.parse(decode(body));
      } else if (type === "text" || type === "") {
        response = decode(body);
      } else {
        response = body;
      }
      setXhrProp(xhr, "status", 200);
      setXhrProp(xhr, "statusText", "OK");
      setXhrProp(xhr, "responseURL", url);
      setXhrProp(xhr, "response", response);
      if (type === "" || type === "text") setXhrProp(xhr, "responseText", response);
      setXhrProp(xhr, "readyState", 4);
      fireXhrEvent(W, xhr, "readystatechange", { loaded: received, total: entry.size, lengthComputable: true });
      fireXhrEvent(W, xhr, "progress", { loaded: received, total: entry.size, lengthComputable: true });
      fireXhrEvent(W, xhr, "load", { loaded: received, total: entry.size, lengthComputable: true });
      fireXhrEvent(W, xhr, "loadend", { loaded: received, total: entry.size, lengthComputable: true });
    }).catch(function (error) {
      setXhrProp(xhr, "status", 0);
      setXhrProp(xhr, "readyState", 4);
      fireXhrEvent(W, xhr, "readystatechange", {});
      try {
        xhr.dispatchEvent(new W.ErrorEvent("error", { message: String(error) }));
      } catch (ignored) {
        fireXhrEvent(W, xhr, "error", {});
      }
      fireXhrEvent(W, xhr, "loadend", {});
    });

    function decode(bytes) {
      if (typeof W.TextDecoder === "function") return new W.TextDecoder("utf-8").decode(bytes);
      var text = "";
      for (var i = 0; i < bytes.length; i++) text += String.fromCharCode(bytes[i]);
      return text;
    }
  }

  if (typeof module !== "undefined" && module.exports && typeof require === "function") {
    module.exports = { chunkSize: CHUNK_SIZE, threshold: THRESHOLD };
    if (require.main === module) runCli(process.argv.slice(2));
  } else if (typeof window !== "undefined") {
    installBrowserShim(window);
  }
})();

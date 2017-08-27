new Promise(resolve => {
  var readyState = document.readyState;
  if (readyState === 'complete' ||
      readyState === 'loaded'  ||
      readyState === 'interactive') {
    resolve();
  } else {
    document.addEventListener('DOMContentLoaded', () => resolve());
  }
}).then(() => {
  var CYCIMG_ATTRIBUTE_NAME = 'cycimg';

  /**
   * @constructor
   */
  var MJpegSplitter = function() {
    /** @private {number} */
    this._state = 1;
    /** @private {number} */
    this._size_to_skip = 0;
    /** @private {!Array<!Blob>} */
    this._blobs = [];
    /** @private {!Array<!Uint8Array>} */
    this._remainings = [];
    /** @private {string} */
    this._FORMAT_ERROR_STR = 'format error';
  };

  MJpegSplitter.prototype = {
    /**
     * @return {!Array<!Blob>}
     */
    get blobs() {
      return this._blobs;
    },
    /**
     * @param {!Uint8Array} chunk
     * @return {!Array.<!Blob>}
     */
    addChunk: function(chunk) {
      this._remainings.push(chunk);
      /** @type {!Array<!Blob>} */
      var blobs = [];
      /** @type {number} */
      var i = 0;
      while (i < chunk.length) {
        if (this._state === 1) {
          if (chunk[i] !== 0xFF) {
            throw new Error(this._FORMAT_ERROR_STR);
          }
          this._state = 2;
          ++i;
        } else if (this._state === 2) {
          if (chunk[i] !== 0xD8) {
            throw new Error(this._FORMAT_ERROR_STR);
          }
          this._state = 3;
          ++i;
        } else if (this._state === 3) {
          if (chunk[i] !== 0xFF) {
            throw new Error(this._FORMAT_ERROR_STR);
          }
          this._state = 4;
          ++i;
        } else if (this._state == 4) {
          var byte = chunk[i];
          if (byte === 0x01 || (byte >= 0xD0 && byte <= 0xD7)) {
            this._state = 3;
            ++i;
          } else if (byte === 0xDA) {
            this._state = 8;
            ++i;
          } else if (byte >= 0x02 && byte <= 0xFE) {
            this._state = 5;
            ++i;
          } else {
            throw new Error(this._FORMAT_ERROR_STR);
          }
        } else if (this._state === 5) {
          this._size_to_skip = chunk[i] * 0x100;
          this._state = 6;
          ++i;
        } else if (this._state === 6) {
          this._size_to_skip = this._size_to_skip + chunk[i] - 2;
          if (this._size_to_skip === 0) {
            throw new Error(this._FORMAT_ERROR_STR);
          }
          this._state = 7;
          ++i;
        } else if (this._state === 7) {
          if (this._size_to_skip + i < chunk.length) {
            i = this._size_to_skip + i;
            this._state = 3;
          } else {
            this._size_to_skip -= chunk.length - i;
            i = chunk.length;
          }
        } else if (this._state === 8) {
          for (; i < chunk.length && chunk[i] !== 0xFF; ++i) {}
          if (i !== chunk.length) {
            this._state = 9;
            ++i;
          }
        } else if (this._state === 9) {
          if (chunk[i] !== 0xD9) {
            this._state = 8;
            ++i;
          } else {
            this._state = 1;
            ++i;
            /** @type {!Array<!Uint8Array>} */
            var chunks_for_blob = [];
            this._remainings.forEach(c => chunks_for_blob.push(c));
            chunks_for_blob.pop();
            chunks_for_blob.push(new Uint8Array(chunk.buffer, chunk.byteOffset, i));
            /** @type {!Blob} */
            var blob = new Blob(chunks_for_blob, {type: 'image/jpeg'});
            this._blobs.push(blob);
            blobs.push(blob);
            chunk = new Uint8Array(chunk.buffer, chunk.byteOffset + i, chunk.length - i);
            i = 0;
            this._remainings = [chunk];
          }
        }
      }
      return blobs;
    }
  };

  /**
   * @param {string} url
   * @return {!Promise<!ArrayBuffer>};
   */
  function fetchXHR(url) {
    var xhr = new XMLHttpRequest();
    xhr.open("GET", url, true);
    xhr.responseType = "arraybuffer";
    return new Promise((resolve, reject) => {
      xhr.onload = (e) => {
        if (!xhr.response) {
          reject(new Error('XHR error'));
        } else {
          resolve(xhr.response);
        }
      };
      xhr.onerror = (e) => {
        reject(e);
      };
      xhr.send(null);
    });
  }

  /**
   * @param {string} url
   * @param {!function(!Blob)} callback
   * @return {!Promise<!Array.<!Blob>>}
   */
  function fetchMotionJpeg(url, callback) {
    if (!('fetch' in window && "ReadableStream" in window)) {
      var xhr = new XMLHttpRequest();
      xhr.open("GET", url, true);
      xhr.responseType = "arraybuffer";
      return fetchXHR(url)
        .then((buffer) => {
          var splitter = new MJpegSplitter();
          var blobs = splitter.addChunk(new Uint8Array(buffer));
          blobs.forEach((blob) => {
            callback(blob);
          })
          return blobs;
        });
    }
    return fetch(url).then(res => {
      var reader =
        /** @type {!ReadableStreamDefaultReader} */
        (res.body.getReader());
      var splitter = new MJpegSplitter();
      return pump();
      function pump() {
        return reader.read().then(result => {
          if (result.done) {
            return splitter.blobs;
          }
          var blobs = splitter.addChunk(/** @type {!Uint8Array} */ (result.value));
          blobs.forEach((blob) => {
            callback(blob);
          })
          return pump();
        });
      }
    });
  }

  /**
   * @constructor
   * @param {!HTMLCanvasElement} canvas
   */
  var CycImageController = function(canvas) {
    this._initialize(canvas);
  };

  CycImageController.prototype = {
    /**
     * @param {!HTMLCanvasElement} canvas
     */
    _initialize: function(canvas) {
      /** @private {!HTMLCanvasElement} */
      this._canvas = canvas;
      this._canvas_ctx = this._canvas.getContext('2d');

      /** @private {number|undefined} */
      this._last_mouse_x = undefined;
      /** @private {number} */
      this._rotation_gamma = 0;
      /** @private {number|undefined} */
      this._last_image_index = undefined;

      /** @private {!Array<!Promise<!Image>>} */
      this._image_promises = [];
    },
    /**
     * @param {!Blob} blob
     */
    AddImageBlob: function(blob) {
      this._image_promises.push(new Promise((resolve) => {
        var img = new Image();
        img.onload = () => {
          window.URL.revokeObjectURL(img.src);
          resolve(img);
        };
        img.src = window.URL.createObjectURL(blob);
      }));
      if (this._image_promises.length === 1) {
        this._RegisterCallback();
      }
      this._update();
    },
    /**
     * @private
     */
    _RegisterCallback: function() {
      this._canvas.addEventListener('mousemove',
                                    this._onMouseMove.bind(this));
      window.addEventListener('deviceorientation',
                              this._onDeviceOrientation.bind(this));
    },
    /**
     * @private
     * @param {!Event} event
     */
    _onDeviceOrientation: function(event) {
      this._rotation_gamma = event.gamma;
      this._update();
    },
    /**
     * @private
     * @param {!Event} event
     */
    _onMouseMove: function(event) {
      if (this._last_mouse_x === undefined) {
        this._last_mouse_x = event.clientX;
      }
      /** @private {number} */
      var diff = event.clientX - this._last_mouse_x;
      this._last_mouse_x = event.clientX;
      this._rotation_gamma += diff / 5;
      if (this._rotation_gamma < -30) {
        this._rotation_gamma = -30;
      } else if (this._rotation_gamma > 30) {
        this._rotation_gamma = 30;
      }
      this._update();
    },
    /**
     * @private
     */
    _update: function() {
      if (this._image_promises.length === 0) {
        return;
      }
      /** @type {number} */
      var index = Math.floor((this._rotation_gamma + 30) * this._image_promises.length / 60);
      if (index < 0) {
        index = 0;
      } else if (index >= this._image_promises.length) {
        index = this._image_promises.length - 1;
      }
      if (this._last_image_index === index) {
        return;
      }
      this._last_image_index = index;
      this._image_promises[index].then((image) => {
        this._canvas.width = image.width;
        this._canvas.height = image.height;
        this._canvas_ctx.clearRect(0, 0, image.width, image.height);
        this._canvas_ctx.drawImage(image, 0, 0, image.width, image.height,
            0, 0, image.width, image.height);
      });
    }
  };
  var cyc_elements = [];
  [].forEach.call(document.getElementsByTagName('img'), (element) => {
    var cycimg = element.getAttribute(CYCIMG_ATTRIBUTE_NAME);
    if (cycimg !== null) {
      cyc_elements.push(element);
    }
  });
  cyc_elements.forEach((element) => {
    var cycimg = element.getAttribute(CYCIMG_ATTRIBUTE_NAME);
    /** @type {?CSSStyleDeclaration} */
    var style = getComputedStyle(element, '');
    var canvas = /** @type {!HTMLCanvasElement} */
                 (document.createElement('canvas'));
    if (style) {
      canvas.style = style;
    }
    /** @type {!HTMLElement} */
    var parent = element.parentElement
    parent.insertBefore(canvas, element);
    parent.removeChild(element);
    /** @type {!CycImageController} */
    var controller = new CycImageController(canvas);
    fetchMotionJpeg(cycimg, (blob) => {
      controller.AddImageBlob(blob);
    });
  });
});

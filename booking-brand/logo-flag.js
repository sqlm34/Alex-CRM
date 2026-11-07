(() => {
  'use strict';
  const motion = matchMedia('(prefers-reduced-motion: reduce)');
  const connection = navigator.connection;
  function fallback() { document.documentElement.classList.remove('logo-pending'); }
  const saveData = connection && connection.saveData;

  function init() {
    const images = document.querySelectorAll('.booking-logo-link img:not([data-booking-flag])');
    images.forEach(img => { img.dataset.bookingFlag = 'true'; img.src = '/booking-brand/logo.webp'; img.width = 120; img.height = 225; });
    if (!images.length || !window.IntersectionObserver) { fallback(); return; }
    const style = document.createElement('style');
    style.textContent = '.flag-logo-wrap{position:relative;display:inline-block;line-height:0;flex:none}.flag-logo-wrap canvas{position:absolute;left:-8%;top:0;width:116%;height:100%;pointer-events:none;max-width:none}.flag-logo-wrap.is-waving>img{opacity:0}';
    document.head.append(style);
    images.forEach(img => {
      try { mount(img); } catch (error) { fallback(); }
    });
  }

  function mount(img) {
    if (img.closest('.flag-logo-wrap')) return;
    const link = img.closest('.booking-logo-link');
    function reveal() { if (link) link.classList.add('flag-ready'); }
    const wrap = document.createElement('span');
    wrap.className = 'flag-logo-wrap';
    img.before(wrap);
    wrap.append(img);
    const canvas = document.createElement('canvas');
    canvas.width = 278; canvas.height = 450;
    canvas.setAttribute('aria-hidden', 'true');
    wrap.append(canvas);
    const gl = canvas.getContext('webgl', { alpha: true, premultipliedAlpha: true, antialias: true });
    if (!gl) { wrap.replaceWith(img); reveal(); return; }
    function shader(type, source) {
      const result = gl.createShader(type);
      gl.shaderSource(result, source);
      gl.compileShader(result);
      if (!gl.getShaderParameter(result, gl.COMPILE_STATUS)) {
        gl.deleteShader(result);
        throw new Error('Logo shader compilation failed');
      }
      return result;
    }
    let program;
    try {
      const vertex = shader(gl.VERTEX_SHADER, `
        attribute vec2 position;
        varying vec2 uv;
        void main() {
          uv = vec2(position.x * .5 + .5, .5 - position.y * .5);
          gl_Position = vec4(position, 0., 1.);
        }
      `);
      const fragment = shader(gl.FRAGMENT_SHADER, `
        precision highp float;
        uniform sampler2D logo;
        uniform float time;
        uniform vec2 resolution;
        varying vec2 uv;
        void main() {
          float weight = uv.y * uv.y;
          float phase = time * 1.15 - uv.y * 4.6;
          float offset = weight * (.043 * sin(phase) + .009 * sin(phase * 1.6));
          float scale = 1. - .025 * weight * (1. + sin(phase + .7));
          vec2 sampleUV = vec2((uv.x * 1.16 - .08 - .5 - offset) / scale + .5, uv.y);
          vec2 edge = vec2(1.16, 1.) / resolution;
          vec2 coverage = smoothstep(vec2(0.), edge, sampleUV)
            * (1. - smoothstep(vec2(1.) - edge, vec2(1.), sampleUV));
          vec4 fabric = texture2D(logo, clamp(sampleUV, 0., 1.));
          // Analytic, broad light lobes: no bitmap lighting grid or scanline strips.
          float fold = sampleUV.x * 8.5 - uv.y * 3.7 - time * 1.15;
          float highlight = exp(-5. * pow(sin(fold * .5), 2.));
          float shadow = exp(-3. * pow(cos(fold * .5), 2.));
          float strength = smoothstep(0., .55, uv.y);
          vec3 color = mix(fabric.rgb, vec3(.66, .79, .96), highlight * .22 * strength);
          color *= 1. - shadow * .16 * strength;
          float alpha = fabric.a * coverage.x * coverage.y;
          gl_FragColor = vec4(color * alpha, alpha);
        }
      `);
      program = gl.createProgram();
      gl.attachShader(program, vertex);
      gl.attachShader(program, fragment);
      gl.linkProgram(program);
      gl.deleteShader(vertex);
      gl.deleteShader(fragment);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error('Logo shader linking failed');
    } catch (error) {
      if (program) gl.deleteProgram(program);
      wrap.replaceWith(img); reveal(); return;
    }
    gl.useProgram(program);
    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const position = gl.getAttribLocation(program, 'position');
    gl.enableVertexAttribArray(position);
    gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.uniform1i(gl.getUniformLocation(program, 'logo'), 0);
    const clock = gl.getUniformLocation(program, 'time');
    const resolution = gl.getUniformLocation(program, 'resolution');
    let visible = false, frame = 0, last = 0, time = 0, uploaded = false, failed = false;
    canvas.dataset.renderer = 'continuous-shader';
    function stop() { cancelAnimationFrame(frame); last = 0; }
    function draw(now) {
      frame = requestAnimationFrame(draw);
      if (last) time += Math.min(now - last, 80) / 1000;
      last = now;
      const bounds = canvas.getBoundingClientRect();
      const density = Math.min(window.devicePixelRatio || 1, 3) * 1.5;
      const width = Math.max(1, Math.round(bounds.width * density));
      const height = Math.max(1, Math.round(bounds.height * density));
      if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
      gl.viewport(0, 0, width, height);
      gl.uniform2f(resolution, width, height);
      gl.uniform1f(clock, time);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      wrap.classList.add('is-waving');
      reveal();
    }
    function sync() {
      stop();
      const ready = img.complete && img.naturalWidth > 0;
      if (failed || motion.matches || saveData) {
        wrap.classList.remove('is-waving'); canvas.hidden = true;
        if (ready) reveal();
        return;
      }
      if (ready && !uploaded) {
        try {
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
          uploaded = true;
        } catch (error) { failed = true; sync(); return; }
      }
      canvas.hidden = false;
      if (ready && visible && !document.hidden) frame = requestAnimationFrame(draw);
    }
    canvas.addEventListener('webglcontextlost', () => { failed = true; sync(); });
    img.addEventListener('load', sync);
    img.addEventListener('error', reveal);
    motion.addEventListener('change', sync);
    document.addEventListener('visibilitychange', sync);
    window.addEventListener('pagehide', stop);
    window.addEventListener('pageshow', sync);
    new IntersectionObserver(entries => { visible = entries[0].isIntersecting; sync(); }).observe(img);
    sync();
  }

  function schedule() {
    if ('requestIdleCallback' in window) requestIdleCallback(init, { timeout: 2500 });
    else setTimeout(init, 600);
  }
  new MutationObserver(() => { if (document.querySelector('.booking-logo-link img:not([data-booking-flag])')) init(); }).observe(document.documentElement, {childList:true,subtree:true});
  if (document.readyState === 'complete') schedule();
  else window.addEventListener('load', schedule, { once: true });
})();

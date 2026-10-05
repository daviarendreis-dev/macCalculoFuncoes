(function() {
    // ==================== CONFIGURAÇÕES E ESTADO ====================
    const canvas = document.getElementById('waveCanvas');
    const ctx = canvas.getContext('2d');
    const spectrumCanvas = document.getElementById('spectrumCanvas');
    const spectrumCtx = spectrumCanvas.getContext('2d');

    const startBtn = document.getElementById('startBtn');
    const stopBtn = document.getElementById('stopBtn');
    const clearBtn = document.getElementById('clearBtn');
    const zoomInBtn = document.getElementById('zoomInBtn');
    const zoomOutBtn = document.getElementById('zoomOutBtn');
    const zoomResetBtn = document.getElementById('zoomResetBtn');
    const zoomLevel = document.getElementById('zoomLevel');
    const statusMsg = document.getElementById('statusMsg');

    const freqValue = document.getElementById('freqValue');
    const rmsValue = document.getElementById('rmsValue');
    const dbValue = document.getElementById('dbValue');
    const normValue = document.getElementById('normValue');
    const funcValue = document.getElementById('funcValue');

    // Web Audio API
    let audioContext = null;
    let oscillator = null;
    let gainNode = null;
    let analyser = null;
    let lfo = null;
    let lfoGain = null;
    let isRunning = false;
    let animationId = null;

    // Dados do frame congelado
    let frozenTimeData = null;
    let frozenFreqData = null;
    let frozenSampleRate = 44100;
    let estimatedFunction = null;

    // Parâmetros da onda gerada — MOVIMENTO VERTICAL LENTO
    const BASE_FREQ = 8;              // Hz — bem lento
    const FREQ_SWING = 2;             // variação ± Hz
    const LFO_RATE = 0.04;            // Hz — ~25s por ciclo de variação
    const AMPLITUDE = 0.55;

    // FFT_SIZE grande => janela de tempo longa => muitos ciclos visíveis e movimento lento
    const FFT_SIZE = 32768;

    // Zoom (escala horizontal do gráfico)
    let zoomFactor = 1.0;
    const ZOOM_MIN = 1.0;
    const ZOOM_MAX = 20.0;
    const ZOOM_STEP = 1.25;
    let panOffset = 0;

    // ==================== CANVAS BASE ====================
    function getCanvasSize() {
        return { w: canvas.width, h: canvas.height };
    }

    function clearCanvas() {
        const { w, h } = getCanvasSize();
        ctx.clearRect(0, 0, w, h);
        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, w, h);

        ctx.strokeStyle = '#00ffcc20';
        ctx.lineWidth = 1;
        for (let i = 0; i <= 4; i++) {
            const y = (h / 4) * i;
            ctx.beginPath();
            ctx.moveTo(0, y);
            ctx.lineTo(w, y);
            ctx.stroke();
        }
        const numV = Math.max(8, Math.round(8 * zoomFactor));
        for (let i = 0; i <= numV; i++) {
            const x = (w / numV) * i;
            ctx.beginPath();
            ctx.moveTo(x, 0);
            ctx.lineTo(x, h);
            ctx.stroke();
        }
    }

    function clearSpectrum() {
        spectrumCtx.clearRect(0, 0, spectrumCanvas.width, spectrumCanvas.height);
        spectrumCtx.fillStyle = '#050505';
        spectrumCtx.fillRect(0, 0, spectrumCanvas.width, spectrumCanvas.height);
        spectrumCtx.strokeStyle = '#00ffcc30';
        spectrumCtx.lineWidth = 0.5;
        const lines = 4;
        for (let i = 0; i < lines; i++) {
            const y = (spectrumCanvas.height / (lines - 1)) * i;
            spectrumCtx.beginPath();
            spectrumCtx.moveTo(0, y);
            spectrumCtx.lineTo(spectrumCanvas.width, y);
            spectrumCtx.stroke();
        }
    }

    // ==================== DESENHO ====================
    function drawWaveformWindowed(dataArray, color = '#00ffcc', lineWidth = 2.5, glow = true) {
        if (!dataArray || dataArray.length === 0) return;
        const { w, h } = getCanvasSize();
        const N = dataArray.length;

        const visibleCount = Math.max(2, Math.floor(N / zoomFactor));
        const maxStart = N - visibleCount;
        const start = Math.max(0, Math.min(maxStart, Math.floor(panOffset * maxStart)));
        const end = Math.min(N, start + visibleCount);

        const visibleSpan = end - start;
        const step = w / visibleSpan;

        ctx.save();
        if (glow) {
            ctx.shadowColor = '#00ffcc';
            ctx.shadowBlur = 15;
        }
        ctx.strokeStyle = color;
        ctx.lineWidth = lineWidth;
        ctx.beginPath();
        let first = true;
        for (let i = start; i < end; i++) {
            const v = dataArray[i] / 128.0;
            const y = (v * h) / 2;
            const x = (i - start) * step;
            if (first) { ctx.moveTo(x, y); first = false; }
            else ctx.lineTo(x, y);
        }
        ctx.stroke();
        ctx.restore();
    }

    // Overlay tracejado — usa a MESMA fórmula ajustada por mínimos quadrados
    function drawEstimatedOverlay() {
        if (!estimatedFunction || !frozenTimeData || frozenTimeData.length === 0) return;
        const { A, freq, phi } = estimatedFunction;
        if (!isFinite(A) || !isFinite(freq) || !isFinite(phi)) return;

        const { w, h } = getCanvasSize();
        const N = frozenTimeData.length;

        const visibleCount = Math.max(2, Math.floor(N / zoomFactor));
        const maxStart = N - visibleCount;
        const start = Math.max(0, Math.min(maxStart, Math.floor(panOffset * maxStart)));
        const end = Math.min(N, start + visibleCount);
        const visibleSpan = end - start;
        const step = w / visibleSpan;

        const sampleRate = frozenSampleRate;
        const omega = 2 * Math.PI * freq / sampleRate;

        ctx.save();
        ctx.strokeStyle = '#ffaa00';
        ctx.lineWidth = 2;
        ctx.setLineDash([6, 6]);
        ctx.shadowColor = '#ffaa00';
        ctx.shadowBlur = 12;
        ctx.beginPath();

        let first = true;
        for (let i = start; i < end; i++) {
            const value = A * Math.sin(omega * i + phi);
            // Mesmo mapeamento vertical do waveform real:
            const y = h / 2 - value * (h / 2) * 0.9;
            const x = (i - start) * step;
            if (first) { ctx.moveTo(x, y); first = false; }
            else ctx.lineTo(x, y);
        }

        ctx.stroke();
        ctx.restore();
    }

    function drawSpectrum(freqData) {
        const cw = spectrumCanvas.width;
        const ch = spectrumCanvas.height;
        spectrumCtx.clearRect(0, 0, cw, ch);
        spectrumCtx.fillStyle = '#050505';
        spectrumCtx.fillRect(0, 0, cw, ch);

        if (!freqData) return;
        const bins = freqData.length;
        const barWidth = cw / bins;

        for (let i = 0; i < bins; i++) {
            const value = freqData[i] / 255;
            const barHeight = value * ch * 0.9;
            const x = i * barWidth;
            const y = ch - barHeight;
            const g = Math.floor(150 + 105 * value);
            const b = Math.floor(200 + 55 * value);
            spectrumCtx.fillStyle = `rgb(0, ${g}, ${b})`;
            spectrumCtx.shadowColor = '#00ffcc';
            spectrumCtx.shadowBlur = 6;
            spectrumCtx.fillRect(x, y, Math.max(1, barWidth - 1), barHeight);
        }
        spectrumCtx.shadowBlur = 0;
    }

    // ==================== ANÁLISE MATEMÁTICA ====================
    function analyzeFrozenFrame(timeData, freqData, sampleRate) {
        if (!timeData || !freqData) return;

        // ---------- 1) Frequência dominante (pico do espectro) ----------
        let peakIndex = 0, peakValue = 0;
        for (let i = 0; i < freqData.length; i++) {
            if (freqData[i] > peakValue) {
                peakValue = freqData[i];
                peakIndex = i;
            }
        }
        const fftSize = freqData.length * 2;
        const frequency = peakIndex * (sampleRate / fftSize);

        // ---------- 2) Ajuste da frequência por zero-crossings ----------
        const N = timeData.length;
        const samples = new Float32Array(N);
        for (let i = 0; i < N; i++) samples[i] = (timeData[i] - 128) / 128;

        const zeroCrossings = [];
        for (let i = 1; i < N; i++) {
            const prev = samples[i - 1];
            const curr = samples[i];
            if (prev < 0 && curr >= 0) {
                const frac = -prev / (curr - prev);
                zeroCrossings.push(i - 1 + frac);
            }
        }

        let freqFromZC = frequency;
        if (zeroCrossings.length > 3) {
            let periodSum = 0, count = 0;
            for (let i = 2; i < zeroCrossings.length; i += 2) {
                const period = zeroCrossings[i] - zeroCrossings[i - 2];
                if (period > 2 && period < N / 2) {
                    periodSum += period;
                    count++;
                }
            }
            if (count > 0) freqFromZC = sampleRate / (periodSum / count);
        }

        // ---------- 3) Regressão por mínimos quadrados ----------
        // Modelo: y(t) = a·sen(ω·t) + b·cos(ω·t)
        // Equivalente a: y(t) = A·sen(ω·t + φ), com A = √(a²+b²), φ = atan2(b, a)
        const omega = 2 * Math.PI * freqFromZC / sampleRate;

        let Sss = 0, Scc = 0, Ssc = 0;
        let Ssy = 0, Scy = 0;
        for (let i = 0; i < N; i++) {
            const s = Math.sin(omega * i);
            const c = Math.cos(omega * i);
            const y = samples[i];
            Sss += s * s;
            Scc += c * c;
            Ssc += s * c;
            Ssy += s * y;
            Scy += c * y;
        }

        const det = Sss * Scc - Ssc * Ssc;
        let a = 0, b = 0;
        if (Math.abs(det) > 1e-10) {
            a = (Ssy * Scc - Scy * Ssc) / det;
            b = (Scy * Sss - Ssy * Ssc) / det;
        }

        // ---------- 4) Extrair A e φ ----------
        const A_fit = Math.sqrt(a * a + b * b);
        const phi_fit = Math.atan2(b, a);

        // ---------- 5) RMS / dB / normalizado ----------
        let sumSquares = 0;
        for (let i = 0; i < N; i++) sumSquares += samples[i] * samples[i];
        const rms = Math.sqrt(sumSquares / N);
        const db = 20 * Math.log10(rms + 1e-10);
        const normalized = Math.min(1, rms * 2);

        // ---------- 6) Guardar função estimada ----------
        estimatedFunction = {
            type: 'sen',
            A: A_fit,
            freq: freqFromZC,
            phi: phi_fit,
            omega: omega
        };

        // ---------- 7) Atualizar UI ----------
        freqValue.textContent = `${freqFromZC.toFixed(1)} Hz`;
        rmsValue.textContent = rms.toFixed(5);
        dbValue.textContent = `${db.toFixed(1)} dB`;
        normValue.textContent = `${(normalized * 100).toFixed(1)} %`;
        funcValue.textContent =
            `y(t) = ${A_fit.toFixed(3)} · sen(2π · ${freqFromZC.toFixed(1)} · t + ${phi_fit.toFixed(2)})`;

        statusMsg.textContent = `⏸ ${freqFromZC.toFixed(1)} Hz · ${db.toFixed(1)} dB`;
    }

    // ==================== LOOP ====================
    function drawFrame() {
        if (!analyser || !isRunning) return;

        const timeData = new Uint8Array(analyser.fftSize);
        const freqData = new Uint8Array(analyser.frequencyBinCount);
        analyser.getByteTimeDomainData(timeData);
        analyser.getByteFrequencyData(freqData);

        clearCanvas();
        drawWaveformWindowed(timeData, '#00ffcc', 2.5, true);
        drawSpectrum(freqData);

        animationId = requestAnimationFrame(drawFrame);
    }

    function redrawFrozen() {
        clearCanvas();
        if (frozenTimeData) {
            drawWaveformWindowed(frozenTimeData, '#00ffcc', 2.5, true);
            drawEstimatedOverlay();
        }
        if (frozenFreqData) {
            drawSpectrum(frozenFreqData);
        }
    }

    // ==================== ÁUDIO ====================
    async function startCapture() {
        if (isRunning) return;
        try {
            statusMsg.textContent = '🎵 Iniciando...';

            if (!audioContext) {
                audioContext = new (window.AudioContext || window.webkitAudioContext)();
            }
            if (audioContext.state === 'suspended') {
                await audioContext.resume();
            }

            oscillator = audioContext.createOscillator();
            oscillator.type = 'sine';
            oscillator.frequency.value = BASE_FREQ;

            lfo = audioContext.createOscillator();
            lfo.type = 'sine';
            lfo.frequency.value = LFO_RATE;
            lfoGain = audioContext.createGain();
            lfoGain.gain.value = FREQ_SWING;
            lfo.connect(lfoGain);
            lfoGain.connect(oscillator.frequency);

            gainNode = audioContext.createGain();
            gainNode.gain.value = AMPLITUDE;

            analyser = audioContext.createAnalyser();
            analyser.fftSize = FFT_SIZE;
            analyser.smoothingTimeConstant = 0.85;

            oscillator.connect(gainNode);
            gainNode.connect(analyser);
            analyser.connect(audioContext.destination);

            oscillator.start();
            lfo.start();

            estimatedFunction = null;
            frozenTimeData = null;
            frozenFreqData = null;

            isRunning = true;
            startBtn.disabled = true;
            stopBtn.disabled = false;
            statusMsg.textContent = '🔊 Tocando...';

            if (animationId) cancelAnimationFrame(animationId);
            drawFrame();

        } catch (err) {
            console.error('Erro ao iniciar áudio:', err);
            statusMsg.textContent = '❌ Erro de áudio';
            startBtn.disabled = false;
            stopBtn.disabled = true;
            isRunning = false;
        }
    }

    function stopAndAnalyze() {
        if (!isRunning || !analyser) return;

        isRunning = false;
        if (animationId) {
            cancelAnimationFrame(animationId);
            animationId = null;
        }

        const timeData = new Uint8Array(analyser.fftSize);
        const freqData = new Uint8Array(analyser.frequencyBinCount);
        analyser.getByteTimeDomainData(timeData);
        analyser.getByteFrequencyData(freqData);

        frozenTimeData = new Uint8Array(timeData);
        frozenFreqData = new Uint8Array(freqData);
        frozenSampleRate = audioContext ? audioContext.sampleRate : 44100;

        try {
            if (oscillator) { oscillator.stop(); oscillator.disconnect(); oscillator = null; }
            if (lfo) { lfo.stop(); lfo.disconnect(); lfo = null; }
            if (lfoGain) { lfoGain.disconnect(); lfoGain = null; }
            if (gainNode) { gainNode.disconnect(); gainNode = null; }
        } catch (e) { /* ignore */ }

        zoomFactor = 1.0;
        panOffset = 0;
        updateZoomLabel();

        analyzeFrozenFrame(frozenTimeData, frozenFreqData, frozenSampleRate);
        redrawFrozen();

        startBtn.disabled = false;
        stopBtn.disabled = true;
    }

    function clearAll() {
        if (isRunning) {
            isRunning = false;
            if (animationId) {
                cancelAnimationFrame(animationId);
                animationId = null;
            }
            try {
                if (oscillator) { oscillator.stop(); oscillator.disconnect(); oscillator = null; }
                if (lfo) { lfo.stop(); lfo.disconnect(); lfo = null; }
                if (lfoGain) { lfoGain.disconnect(); lfoGain = null; }
                if (gainNode) { gainNode.disconnect(); gainNode = null; }
            } catch (e) { /* ignore */ }
        }

        frozenTimeData = null;
        frozenFreqData = null;
        estimatedFunction = null;
        zoomFactor = 1.0;
        panOffset = 0;
        updateZoomLabel();

        clearCanvas();
        clearSpectrum();

        freqValue.textContent = '— Hz';
        rmsValue.textContent = '—';
        dbValue.textContent = '— dB';
        normValue.textContent = '— %';
        funcValue.textContent = '—';

        startBtn.disabled = false;
        stopBtn.disabled = true;
        statusMsg.textContent = '🔇 Pronto';
    }

    // ==================== ZOOM ====================
    function updateZoomLabel() {
        zoomLevel.textContent = zoomFactor.toFixed(1) + '×';
        zoomInBtn.disabled = zoomFactor >= ZOOM_MAX;
        zoomOutBtn.disabled = zoomFactor <= ZOOM_MIN;
    }

    function applyZoom(newZoom) {
        newZoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, newZoom));
        if (newZoom === zoomFactor) return;

        const center = panOffset + (1 / zoomFactor) / 2;
        zoomFactor = newZoom;
        const newWidth = 1 / zoomFactor;
        panOffset = Math.max(0, Math.min(1 - newWidth, center - newWidth / 2));

        updateZoomLabel();
        if (!isRunning) redrawFrozen();
        else drawFrameOnce();
    }

    function drawFrameOnce() {
        if (!analyser) return;
        const timeData = new Uint8Array(analyser.fftSize);
        const freqData = new Uint8Array(analyser.frequencyBinCount);
        analyser.getByteTimeDomainData(timeData);
        analyser.getByteFrequencyData(freqData);
        clearCanvas();
        drawWaveformWindowed(timeData, '#00ffcc', 2.5, true);
        drawSpectrum(freqData);
    }

    // ==================== EVENTOS ====================
    startBtn.addEventListener('click', startCapture);
    stopBtn.addEventListener('click', stopAndAnalyze);
    clearBtn.addEventListener('click', clearAll);

    zoomInBtn.addEventListener('click', () => applyZoom(zoomFactor * ZOOM_STEP));
    zoomOutBtn.addEventListener('click', () => applyZoom(zoomFactor / ZOOM_STEP));
    zoomResetBtn.addEventListener('click', () => {
        zoomFactor = 1.0;
        panOffset = 0;
        updateZoomLabel();
        if (!isRunning) redrawFrozen();
        else drawFrameOnce();
    });

    canvas.addEventListener('wheel', (e) => {
        e.preventDefault();
        if (e.deltaY < 0) applyZoom(zoomFactor * ZOOM_STEP);
        else applyZoom(zoomFactor / ZOOM_STEP);
    }, { passive: false });

    let isDragging = false;
    let dragStartX = 0;
    let dragStartPan = 0;

    canvas.addEventListener('mousedown', (e) => {
        if (zoomFactor <= 1.0) return;
        isDragging = true;
        dragStartX = e.clientX;
        dragStartPan = panOffset;
        canvas.style.cursor = 'grabbing';
    });
    window.addEventListener('mousemove', (e) => {
        if (!isDragging) return;
        const rect = canvas.getBoundingClientRect();
        const dx = e.clientX - dragStartX;
        const visibleWidth = 1 / zoomFactor;
        const deltaFrac = -(dx / rect.width) * visibleWidth;
        panOffset = Math.max(0, Math.min(1 - visibleWidth, dragStartPan + deltaFrac));
        if (!isRunning) redrawFrozen();
        else drawFrameOnce();
    });
    window.addEventListener('mouseup', () => {
        isDragging = false;
        canvas.style.cursor = 'default';
    });

    let touchStartX = 0;
    let touchStartPan = 0;
    let isTouching = false;
    canvas.addEventListener('touchstart', (e) => {
        if (zoomFactor <= 1.0 || e.touches.length !== 1) return;
        isTouching = true;
        touchStartX = e.touches[0].clientX;
        touchStartPan = panOffset;
    }, { passive: true });
    canvas.addEventListener('touchmove', (e) => {
        if (!isTouching || e.touches.length !== 1) return;
        const rect = canvas.getBoundingClientRect();
        const dx = e.touches[0].clientX - touchStartX;
        const visibleWidth = 1 / zoomFactor;
        const deltaFrac = -(dx / rect.width) * visibleWidth;
        panOffset = Math.max(0, Math.min(1 - visibleWidth, touchStartPan + deltaFrac));
        if (!isRunning) redrawFrozen();
        else drawFrameOnce();
        e.preventDefault();
    }, { passive: false });
    canvas.addEventListener('touchend', () => { isTouching = false; }, { passive: true });

    // Inicialização
    updateZoomLabel();
    clearCanvas();
    clearSpectrum();
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
})();
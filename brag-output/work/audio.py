import json, sys, wave
import numpy as np
SR = 44100
name = sys.argv[1]
spec = json.load(open(f'{name}.sfx.json'))
dur = spec['dur']
N = int(SR * (dur + 0.05))
t = np.arange(N) / SR
rng = np.random.default_rng(7)
mtof = lambda m: 440 * 2 ** ((m - 69) / 12)

def lp(x, a):  # one-pole lowpass
    y = np.empty_like(x); s = 0.0
    for i in range(len(x)):
        s += a * (x[i] - s); y[i] = s
    return y

def env(n, a, r):
    e = np.ones(n); na = max(1, int(a * SR)); e[:na] = np.linspace(0, 1, na)
    e *= np.exp(-np.arange(n) / (r * SR)); return e

def pluck(m, d=0.9, bright=1.0):
    n = int(d * SR); tt = np.arange(n) / SR; f = mtof(m)
    x = np.sin(2*np.pi*f*tt) + 0.35*bright*np.sin(2*np.pi*2*f*tt) + 0.12*bright*np.sin(2*np.pi*3*f*tt)
    return x * env(n, 0.004, d / 4)

def add(buf, x, at, g):
    i = int(at * SR)
    if i >= len(buf): return
    x = x[: len(buf) - i]; buf[i:i+len(x)] += g * x

music = np.zeros(N); fx = np.zeros(N)
bpm = 100; beat = 60 / bpm; bar = 4 * beat
# D  Bm  G  A
chords = [[50, 57, 62, 66, 69], [47, 54, 62, 66, 71], [43, 55, 62, 67, 71], [45, 57, 61, 64, 69]]
nbars = int(dur / bar) + 2
for b in range(nbars):
    ch = chords[(b // 1) % 4]
    st = b * bar
    n = int(bar * SR * 1.15); tt = np.arange(n) / SR
    pad = sum(np.sin(2*np.pi*mtof(m)*tt + 0.3*np.sin(2*np.pi*0.25*tt)) * (0.5 if m < 52 else 0.22) for m in ch)
    pe = np.minimum(1, tt / 0.5) * np.minimum(1, (bar*1.15 - tt) / 0.5)
    add(music, pad * pe, st, 0.09)
    # arpeggio 8ths
    arp = [ch[1] + 12, ch[2] + 12, ch[3] + 12, ch[4] + 12, ch[3] + 12, ch[2] + 12, ch[4] + 12, ch[3] + 24]
    for k, m in enumerate(arp):
        add(music, pluck(m, 0.5, 0.6), st + k * beat / 2, 0.055 if k % 2 else 0.075)
    # soft kick + hat
    for k in range(4):
        kn = int(0.25 * SR); kt = np.arange(kn) / SR
        kick = np.sin(2*np.pi*(48 + 70*np.exp(-kt*30))*kt) * np.exp(-kt*14)
        add(music, kick, st + k*beat, 0.22)
        hn = int(0.05*SR); hat = rng.standard_normal(hn) * np.exp(-np.arange(hn)/(0.01*SR))
        add(music, np.diff(hat, prepend=0), st + k*beat + beat/2, 0.025)
# intro fade-in, outro fade
music *= np.minimum(1, t / 0.6) * np.clip((dur - t) / 1.6, 0, 1)

scale = [62, 64, 66, 69, 71, 74, 76, 78, 81]
for i, e in enumerate(spec['sfx']):
    k, g, at = e['kind'], e['gain'], e['t']
    if k == 'key':
        n = int(0.03*SR); x = np.diff(rng.standard_normal(n), prepend=0) * np.exp(-np.arange(n)/(0.004*SR))
        add(fx, lp(x, 0.5), at, 0.05 * g)
    elif k == 'enter':
        add(fx, pluck(74, 0.25, 0.3), at, 0.06 * g)
    elif k == 'click':
        n = int(0.04*SR); x = np.sin(2*np.pi*1800*np.arange(n)/SR) * np.exp(-np.arange(n)/(0.006*SR))
        add(fx, x, at, 0.06 * g)
    elif k == 'blip':
        add(fx, pluck(scale[i % len(scale)] + 12, 0.3, 0.2), at, 0.05 * g)
    elif k == 'tick':
        add(fx, pluck(81, 0.4, 0.3), at, 0.06 * g); add(fx, pluck(86, 0.4, 0.3), at + 0.07, 0.05 * g)
    elif k == 'paste':
        for j, m in enumerate([74, 78, 81, 86]): add(fx, pluck(m, 0.5, 0.3), at + j*0.05, 0.05 * g)
    elif k == 'chime':
        n = int(1.6*SR); tt = np.arange(n)/SR
        x = (np.sin(2*np.pi*mtof(86)*tt) + 0.5*np.sin(2*np.pi*mtof(93)*tt) + 0.2*np.sin(2*np.pi*mtof(98)*tt)) * env(n, 0.005, 0.45)
        add(fx, x, at, 0.09 * g)
    elif k == 'whoosh':
        n = int(0.7*SR); x = rng.standard_normal(n); e2 = np.sin(np.pi*np.arange(n)/n)**2
        add(fx, lp(x, 0.06) * e2, at - 0.2, 0.25 * g)
    elif k == 'swell':
        n = int(3.2*SR); tt = np.arange(n)/SR
        x = sum(np.sin(2*np.pi*mtof(m)*tt) for m in [62, 69, 74, 78, 81]) * np.minimum(1, tt/0.08) * np.exp(-tt/1.3)
        add(fx, x, at, 0.05 * g)
# simple room on fx so it sits in the same space
wet = np.zeros_like(fx)
for d, g in [(0.043, 0.35), (0.071, 0.28), (0.113, 0.2), (0.167, 0.14)]:
    i = int(d*SR); wet[i:] += fx[:-i] * g
fx = fx + lp(wet, 0.3)
mix = music + fx
mix = np.tanh(mix * 1.6) / 1.6
mix *= 0.89 / np.max(np.abs(mix))
st = np.stack([mix, np.roll(mix, int(0.0007*SR))], 1)
with wave.open(f'{name}.wav', 'wb') as w:
    w.setnchannels(2); w.setsampwidth(2); w.setframerate(SR)
    w.writeframes((st * 32767).astype(np.int16).tobytes())
print('wav', name, dur)

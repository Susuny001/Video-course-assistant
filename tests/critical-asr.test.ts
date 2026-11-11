import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

// Exercise the adapter without downloading a model or relying on ASR wording.
// Each fake sample is its source index, so omissions at a split are observable.
const fixture = String.raw`
import importlib.util, json, sys, tempfile
from pathlib import Path
from types import SimpleNamespace

spec = importlib.util.spec_from_file_location("critical", "scripts/critical-transcribe.py")
critical = importlib.util.module_from_spec(spec)
spec.loader.exec_module(critical)
calls, options = [], []
class ActualStream:
    def accept_waveform(self, rate, samples):
        assert rate == 16000
        calls.append((len(samples), samples[0], samples[-1]))
        self.result = SimpleNamespace(text=" decoded ")
class ActualRecognizer:
    def create_stream(self): return ActualStream()
    def decode_stream(self, stream): pass
def from_whisper(**kwargs):
    options.append(kwargs)
    return ActualRecognizer()
sys.modules["numpy"] = SimpleNamespace(asarray=lambda samples, dtype: samples, float32="float32")
sys.modules["sherpa_onnx"] = SimpleNamespace(
    OfflineRecognizer=SimpleNamespace(from_whisper=from_whisper),
    VadModelConfig=lambda: SimpleNamespace(silero_vad=SimpleNamespace()),
    VoiceActivityDetector=lambda config, **kwargs: config,
)
`;

async function mockedAdapter(body: string) {
  const { stdout } = await exec('python3', ['-c', fixture + body]);
  return JSON.parse(stdout);
}

test('Whisper decodes every sample of long VAD turns in windows below its 30 second limit', async () => {
  const result = await mockedAdapter(String.raw`
with tempfile.TemporaryDirectory() as directory:
    model = Path(directory)
    for name in ["turbo-encoder.int8.onnx", "turbo-decoder.int8.onnx", "turbo-tokens.txt", "silero_vad.onnx"]:
        (model/name).touch()
    args = SimpleNamespace(model_dir=model, language="auto", threads=2)
    _, recognizer, _ = critical.load_models(args)
    outputs = []
    for count in [1, 27*16000, 27*16000+1, 60*16000]:
        calls.clear()
        stream = recognizer.create_stream()
        stream.accept_waveform(16000, range(count))
        recognizer.decode_stream(stream)
        outputs.append({"count": count, "calls": list(calls), "text": stream.result.text})
    print(json.dumps({"outputs": outputs, "options": options, "language": args.language}))
`);
  assert.equal(result.language, 'zh');
  assert.equal(result.options.length, 1);
  assert.equal(result.options[0].task, 'transcribe');
  assert.equal(result.options[0].language, 'zh');
  assert.equal(result.options[0].num_threads, 2);
  assert.ok(!('initial_prompt' in result.options[0]));
  for (const output of result.outputs) {
    let nextIndex = 0;
    for (const [length, first, last] of output.calls) {
      assert.ok(length > 0 && length <= 27 * 16000);
      assert.equal(first, nextIndex);
      assert.equal(last, nextIndex + length - 1);
      nextIndex += length;
    }
    assert.equal(nextIndex, output.count);
    assert.equal(output.text, 'decoded'.repeat(output.calls.length));
  }
});

test('Whisper rejects an unsupported input sample rate instead of decoding it at the wrong speed', async () => {
  const result = await mockedAdapter(String.raw`
with tempfile.TemporaryDirectory() as directory:
    model = Path(directory)
    for name in ["turbo-encoder.int8.onnx", "turbo-decoder.int8.onnx", "turbo-tokens.txt", "silero_vad.onnx"]:
        (model/name).touch()
    _, recognizer, _ = critical.load_models(SimpleNamespace(model_dir=model, language="zh", threads=1))
    stream = recognizer.create_stream()
    try:
        stream.accept_waveform(8000, range(80))
    except ValueError as error:
        print(json.dumps({"error": str(error), "decodeCalls": len(calls)}))
    else:
        raise AssertionError("unsupported sample rate was accepted")
`);
  assert.match(result.error, /16 kHz/);
  assert.equal(result.decodeCalls, 0);
});

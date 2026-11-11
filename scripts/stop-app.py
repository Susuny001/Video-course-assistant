#!/usr/bin/env python3
"""Stop only a Linux/macOS server whose PID record still matches this checkout."""
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
ROOT=Path(__file__).resolve().parents[1]
record_path=Path(os.environ.get('DATA_DIR',str(ROOT/'data'))).resolve()/'launcher.json'
if not record_path.is_file():
    print('No app started by the background launcher is recorded.')
    raise SystemExit(0)
record=json.loads(record_path.read_text())
entry=str(ROOT/'server/index.ts')
if record.get('entry')!=entry or not isinstance(record.get('processId'),int):
    raise SystemExit('The PID record does not belong to this checkout; no process was stopped.')
pid=record['processId']
try:
    if sys.platform.startswith('linux'):
        command=Path(f'/proc/{pid}/cmdline').read_bytes().split(b'\0')
        started=Path(f'/proc/{pid}/stat').read_text().split(') ',1)[1].split()[19]
        valid=bool(command) and Path(command[0].decode()).name.startswith('node') and entry.encode() in command and started==record.get('procStartTicks')
    else:
        command=subprocess.check_output(['ps','-p',str(pid),'-o','command='],text=True)
        started=subprocess.check_output(['ps','-p',str(pid),'-o','lstart='],text=True).strip()
        valid=entry in command and started==record.get('procStartedAt')
except (FileNotFoundError,ProcessLookupError,subprocess.CalledProcessError):
    record_path.unlink(missing_ok=True)
    print('The recorded app is no longer running.')
    raise SystemExit(0)
if not valid:
    raise SystemExit('The PID has been reused or its identity changed; no process was stopped.')
os.kill(pid,signal.SIGTERM)
record_path.unlink(missing_ok=True)
print('Course assistant stopped. Model installation processes were left running.')

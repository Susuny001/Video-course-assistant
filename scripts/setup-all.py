#!/usr/bin/env python3
"""Prepare and start the local course assistant; progress survives closed terminals."""
from __future__ import annotations
import argparse
import datetime as dt
import html
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request

ROOT = Path(__file__).resolve().parents[1]


def atomic_json(filename: Path, value: dict) -> None:
    filename.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile('w', encoding='utf-8', dir=filename.parent, delete=False) as output:
        json.dump(value, output, ensure_ascii=False, indent=2)
        temporary = Path(output.name)
    os.replace(temporary, filename)


class Progress:
    def __init__(self, directory: Path, port: int):
        self.directory = directory
        self.filename = directory / 'status.json'
        self.page = directory / 'status.html'
        self.value = {'schema': 1, 'status': 'running', 'message': '正在准备本机学习环境', 'stages': [], 'port': port, 'updatedAt': ''}
        self.write()

    def write(self) -> None:
        self.value['updatedAt'] = dt.datetime.now(dt.timezone.utc).isoformat()
        atomic_json(self.filename, self.value)
        complete = self.value['status'] in ['ready', 'ready_with_optional']
        refresh = f'http://127.0.0.1:{self.value["port"]}' if complete else ''
        rows = ''.join(f'<li class="{html.escape(s["status"])}"><strong>{html.escape(s["title"])}</strong><small>{html.escape(s.get("message", ""))}</small><span>{html.escape({"running":"进行中","done":"已完成","error":"需要处理","skipped":"未安装","pending":"等待"}.get(s["status"],s["status"]))}</span></li>' for s in self.value['stages'])
        warning = '<p class="warning">语音处理已准备好，部分可选模型未安装。进入应用后可查看具体能力，缺少的模型不会显示为已完成。</p>' if self.value['status'] == 'ready_with_optional' else ''
        meta = f'<meta http-equiv="refresh" content="3;url={html.escape(refresh or self.page.as_uri(), quote=True)}">' if self.value['status'] != 'error' else ''
        document = f'''<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">{meta}<title>知课 · 环境准备</title><style>body{{font:15px/1.8 system-ui,sans-serif;background:#f5f7f2;color:#354c38;margin:0;padding:6vh 20px}}main{{max-width:760px;margin:auto;background:white;border:1px solid #dde5d6;border-radius:16px;padding:32px}}h1{{font-size:26px;margin:0 0 8px}}p{{color:#73836a}}ul{{padding:0;list-style:none}}li{{padding:16px 0;border-top:1px solid #edf0e8;position:relative;padding-right:85px}}strong,small{{display:block}}small{{font-size:12px;color:#8a957f;overflow-wrap:anywhere}}li span{{position:absolute;right:0;top:18px;font-size:12px}}.done span{{color:#538450}}.error span,.warning{{color:#aa754f}}a{{color:#567d4d}}footer{{font-size:12px;color:#97a38b;margin-top:20px}}</style><main><h1>正在准备你的学习空间</h1><p>{html.escape(self.value['message'])}</p><ul>{rows}</ul>{warning}<p>下载和安装在后台继续，可以关闭这个页面，稍后重新打开 install.bat 查看进度。</p><a href="{html.escape((ROOT/'data/logs/setup.log').as_uri(),quote=True)}">查看安装日志</a><footer>原始课程资料保留 · 模型文件校验后使用 · 不需要 API Key</footer></main></html>'''
        self.page.write_text(document, encoding='utf-8')

    def stage(self, key: str, title: str, status: str, message: str = '') -> None:
        existing = next((s for s in self.value['stages'] if s['key'] == key), None)
        if existing is None:
            existing = {'key': key, 'title': title}
            self.value['stages'].append(existing)
        existing.update(status=status, message=message[-400:])
        self.value['message'] = title + ('：' + message[-180:] if message else '')
        self.write()

    def command(self, key: str, title: str, command: list[str], optional: bool = False) -> bool:
        self.stage(key, title, 'running')
        print(f'[{key}] {title}', flush=True)
        try:
            process = subprocess.Popen(command, cwd=ROOT, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, encoding='utf-8', errors='replace', env={**os.environ, 'PYTHONUNBUFFERED': '1'})
            assert process.stdout is not None
            for line in process.stdout:
                print(line.rstrip(), flush=True)
                text = line.strip()
                if text:
                    try:
                        item = json.loads(text)
                        text = item.get('progress') or item.get('message') or text
                    except (ValueError, TypeError):
                        pass
                    self.stage(key, title, 'running', str(text))
            if process.wait() != 0:
                raise RuntimeError(f'{title}未完成，详情见安装日志。')
            self.stage(key, title, 'done')
            return True
        except Exception as exc:
            self.stage(key, title, 'skipped' if optional else 'error', str(exc))
            if not optional:
                raise
            return False


def check_toolchain() -> None:
    if sys.version_info < (3, 11):
        raise RuntimeError('需要 Python 3.11+，推荐 Python 3.12。')
    for command in ['node', 'npm.cmd' if os.name == 'nt' else 'npm', 'ffmpeg', 'ffprobe']:
        if not shutil.which(command):
            raise RuntimeError(f'缺少 {command}；Windows 请运行 install.bat 自动安装，其他平台先安装该工具。')
    version = subprocess.check_output(['node', '--version'], text=True).strip().removeprefix('v').split('.')
    if tuple(map(int, version[:2])) < (22, 12):
        raise RuntimeError('需要 Node.js 22.12+，推荐 Node.js 24 LTS。')


def health(port: int) -> bool:
    try:
        with urllib.request.urlopen(f'http://127.0.0.1:{port}/api/health', timeout=2) as response:
            return json.load(response).get('service') == 'video-course-assistant'
    except Exception:
        return False


def server_start(progress: Progress, port: int, app_data: Path) -> None:
    with socket.socket() as probe:
        if probe.connect_ex(('127.0.0.1', port)) == 0:
            if health(port):
                progress.stage('start', '启动应用', 'done', f'已在本机 {port} 端口运行')
                return
            raise RuntimeError(f'{port} 端口被其他服务使用，未结束该服务。请设置 PORT 后重试。')
    logs = app_data / 'logs'
    logs.mkdir(parents=True, exist_ok=True)
    env = {**os.environ, 'HOST': '127.0.0.1', 'PORT': str(port), 'DATA_DIR': str(app_data)}
    entry = ROOT / 'server/index.ts'
    with (logs/'server.log').open('a', encoding='utf-8') as out, (logs/'server-error.log').open('a', encoding='utf-8') as err:
        process = subprocess.Popen([shutil.which('node') or 'node', '--import', 'tsx', str(entry)], cwd=ROOT, env=env, stdout=out, stderr=err, start_new_session=os.name != 'nt')
    record = {'processId': process.pid, 'entry': str(entry), 'port': port, 'platform': sys.platform}
    if sys.platform.startswith('linux'):
        record['procStartTicks'] = Path(f'/proc/{process.pid}/stat').read_text().split(') ', 1)[1].split()[19]
    elif sys.platform == 'darwin':
        record['procStartedAt'] = subprocess.check_output(['ps','-p',str(process.pid),'-o','lstart='],text=True).strip()
    atomic_json(app_data/'launcher.json', record)
    progress.stage('start', '启动应用', 'running', '正在检查网页和课程接口')
    for _ in range(80):
        if process.poll() is not None:
            raise RuntimeError('应用启动失败，详情见 data/logs/server-error.log。')
        if health(port):
            with urllib.request.urlopen(f'http://127.0.0.1:{port}/api/courses', timeout=5) as response:
                if not isinstance(json.load(response), list):
                    raise RuntimeError('课程接口未返回有效结果。')
            progress.stage('start', '启动应用', 'done', f'已通过健康与课程读取检查：本机 {port} 端口')
            return
        time.sleep(.25)
    process.terminate()
    raise RuntimeError('应用未在预计时间内就绪，请查看启动日志。')


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--start', action='store_true', help='Start the app after installation (Linux/macOS).')
    parser.add_argument('--start-only', action='store_true', help='Validate installed models and start without reinstalling dependencies.')
    parser.add_argument('--check-only', action='store_true', help='Check actual installed models without npm or downloads.')
    parser.add_argument('--skip-text-model', action='store_true')
    parser.add_argument('--skip-critical-model', action='store_true')
    parser.add_argument('--app-data-dir', type=Path, default=Path(os.environ.get('DATA_DIR', str(ROOT/'data'))))
    parser.add_argument('--state-dir', type=Path, default=ROOT/'data/setup')
    parser.add_argument('--port', type=int, default=int(os.environ.get('PORT', '3001')))
    args = parser.parse_args()
    progress = Progress(args.state_dir.resolve(), args.port)
    try:
        if not 1 <= args.port <= 65535:
            raise ValueError('PORT 必须在 1 到 65535 之间。')
        progress.stage('tools', '检查运行工具', 'running')
        check_toolchain()
        progress.stage('tools', '检查运行工具', 'done', 'Node.js、Python、FFmpeg 可用')
        python = ROOT/'data/local-asr/venv'/('Scripts/python.exe' if os.name == 'nt' else 'bin/python')
        npm = shutil.which('npm.cmd' if os.name == 'nt' else 'npm') or 'npm'
        if not args.check_only and not args.start_only:
            if health(args.port):
                raise RuntimeError('应用正在运行。先停止本项目的应用再安装，避免中断课程处理。')
            progress.command('app', '安装应用依赖', [npm, 'ci', '--cache', str(ROOT/'data/npm-cache'), '--no-audit', '--no-fund'])
            progress.command('build', '构建学习界面', [npm, 'run', 'build'])
            progress.command('speech', '安装本地中文识别', [sys.executable, str(ROOT/'scripts/setup-local-asr.py')])
            progress.command('crosscheck', '安装独立语音复核模型', [sys.executable, str(ROOT/'scripts/setup-independent-asr.py')])
        progress.command('speech-check', '核验本地中文识别', [str(python), str(ROOT/'scripts/local-transcribe.py'), '--model-dir', str(ROOT/'data/local-asr/model'), '--threads', '2', '--check'])
        progress.command('crosscheck-check', '核验独立语音复核模型', [str(python), str(ROOT/'scripts/independent-transcribe.py'), '--model-dir', str(ROOT/'data/local-asr/paraformer/model'), '--threads', '2', '--check'])
        optional = False
        critical_installer=ROOT/'scripts/setup-critical-asr.py'
        critical_ready=False
        if critical_installer.is_file() and not args.skip_critical_model:
            if args.check_only or args.start_only:
                critical_ready=progress.command('critical','核验重点复听模型',[str(python),str(ROOT/'scripts/critical-transcribe.py'),'--model-dir',str(ROOT/'data/local-asr/whisper/model'),'--threads','2','--check'],optional=True)
            else:
                critical_ready=progress.command('critical','安装重点复听模型',[sys.executable,str(critical_installer)],optional=True)
        else:
            progress.stage('critical','重点复听模型','skipped','未安装可选的第三语音模型，疑似错词保留为待审查项')
        optional=not critical_ready
        text_installer = ROOT/'scripts/setup-local-model.py'
        if text_installer.is_file() and not args.skip_text_model:
            text_ready = progress.command('text', '准备本地文档与答疑模型', [sys.executable, str(text_installer), *(['--check'] if args.check_only or args.start_only else [])], optional=True)
            optional = optional or not text_ready
        else:
            text_ready=False
            optional = True
            progress.stage('text', '本地文档与答疑模型', 'skipped', '未安装可选文本模型；语音识别与独立复核仍可使用')
        atomic_json(args.state_dir.resolve()/'readiness.json', {'ready': True, 'speech': True, 'independentSpeech': True, 'text': text_ready, 'criticalSpeech':critical_ready, 'checkedAt': dt.datetime.now(dt.timezone.utc).isoformat()})
        if (args.start or args.start_only) and not args.check_only:
            server_start(progress, args.port, args.app_data_dir.resolve())
            progress.value['status'] = 'ready_with_optional' if optional else 'ready'
            progress.value['message'] = '应用已在后台启动，马上进入学习空间。'
        else:
            progress.value['status'] = 'installed_with_optional' if optional else 'installed'
            progress.value['message'] = '本地语音与独立复核模型已检查通过。' + ('部分辅助模型未就绪，请查看各阶段状态。' if optional else '')
        progress.write()
        return 0
    except Exception as exc:
        progress.value.update(status='error', message=str(exc))
        progress.write()
        print(f'环境准备未完成：{exc}', file=sys.stderr, flush=True)
        return 1


if __name__ == '__main__':
    raise SystemExit(main())

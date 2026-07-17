#!/usr/bin/env bash
# =============================================================================
# pi video-summary extension — one-line installer (idempotent)
#
#   bash ~/.pi/agent/extensions/video-summary/install.sh
#
# Installs: ffmpeg (apt), python venv, faster-whisper + CUDA libs (when an
# NVIDIA GPU is present), yt-dlp; pre-downloads the whisper model; writes a
# starter config.json. Safe to re-run: existing pieces are skipped/upgraded.
#
# Env overrides:
#   VS_MODEL=large-v3-turbo   whisper model to pre-download (VS_SKIP_MODEL=1 to skip)
#   VS_NO_APT=1               skip system package installation
# =============================================================================
set -euo pipefail

EXT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd || true)"
if [[ -z "${EXT_DIR}" || ! -f "${EXT_DIR}/transcribe.py" ]]; then
	EXT_DIR="$HOME/.pi/agent/extensions/video-summary"
fi
# Mutable state (venv, models, config, dictionary) lives OUTSIDE the package
# dir so `pi update` re-clones never wipe it.
DATA_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/pi-video-summary"
VENV="${DATA_DIR}/.venv"
MODELS="${DATA_DIR}/models"
MODEL="${VS_MODEL:-large-v3-turbo}"
mkdir -p "${DATA_DIR}" "${MODELS}"

say() { printf '\033[1;34m[install]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[install]\033[0m %s\n' "$*" >&2; }
die() {
	printf '\033[1;31m[install]\033[0m %s\n' "$*" >&2
	exit 1
}

[[ "$(uname -s)" == "Linux" ]] || warn "This installer targets Linux; on macOS install ffmpeg via brew and CUDA steps are skipped."

# ---------------------------------------------------------------- sudo helper
SUDO=""
if [[ "$(id -u)" != "0" ]]; then
	command -v sudo >/dev/null 2>&1 && SUDO="sudo" || warn "not root and no sudo — system package steps may fail"
fi

apt_install() {
	[[ "${VS_NO_APT:-0}" == "1" ]] && return 0
	command -v apt-get >/dev/null 2>&1 || {
		warn "no apt-get; please install $* manually"
		return 0
	}
	say "apt-get install: $*"
	$SUDO apt-get update -qq || true
	DEBIAN_FRONTEND=noninteractive $SUDO apt-get install -y -qq "$@"
}

# ---------------------------------------------------------------- ffmpeg
if ! command -v ffmpeg >/dev/null 2>&1 || ! command -v ffprobe >/dev/null 2>&1; then
	apt_install ffmpeg
fi
command -v ffmpeg >/dev/null 2>&1 || die "ffmpeg not found and could not be installed"
say "ffmpeg: $(ffmpeg -version 2>/dev/null | head -1)"

# ---------------------------------------------------------------- python venv
PYTHON_BIN="$(command -v python3 || true)"
[[ -n "${PYTHON_BIN}" ]] || apt_install python3
PYTHON_BIN="$(command -v python3 || true)"
[[ -n "${PYTHON_BIN}" ]] || die "python3 not found"

PY_VER="$(${PYTHON_BIN} -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")')"
say "python: ${PY_VER}"
${PYTHON_BIN} -c 'import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)' ||
	die "python >= 3.10 required (found ${PY_VER})"

if [[ ! -x "${VENV}/bin/python" ]]; then
	say "creating venv at ${VENV}"
	${PYTHON_BIN} -m venv "${VENV}" 2>/dev/null || {
		warn "venv module missing — installing python3-venv"
		apt_install "python3-venv" || apt_install "python${PY_VER}-venv"
		${PYTHON_BIN} -m venv "${VENV}"
	}
fi
PY="${VENV}/bin/python"
say "upgrading pip"
"${PY}" -m pip install -q -U pip

# ---------------------------------------------------------------- python deps
GPU=0
if command -v nvidia-smi >/dev/null 2>&1 && nvidia-smi >/dev/null 2>&1; then GPU=1; fi

say "installing yt-dlp + faster-whisper (latest)"
"${PY}" -m pip install -q -U yt-dlp faster-whisper

if [[ "${GPU}" == "1" ]]; then
	say "NVIDIA GPU detected — installing CUDA runtime libs (cuBLAS/cuDNN cu12)"
	"${PY}" -m pip install -q -U nvidia-cublas-cu12 nvidia-cudnn-cu12
else
	warn "no NVIDIA GPU — transcription will run on CPU (set transcribe.device=cpu to silence fallback logs)"
fi

# ---------------------------------------------------------------- CUDA smoke test
if [[ "${GPU}" == "1" ]]; then
	SP="$("${PY}" -c 'import site; print(site.getsitepackages()[0])')"
	export LD_LIBRARY_PATH="${SP}/nvidia/cublas/lib:${SP}/nvidia/cudnn/lib:${LD_LIBRARY_PATH:-}"
	if "${PY}" -c 'import ctranslate2; n=ctranslate2.get_cuda_device_count(); print(f"CUDA devices visible to ctranslate2: {n}"); exit(0 if n>0 else 1)'; then
		say "CUDA acceleration OK ✓"
	else
		warn "ctranslate2 cannot see the GPU — will fall back to CPU at runtime"
	fi
fi

# ---------------------------------------------------------------- whisper model
if [[ "${VS_SKIP_MODEL:-0}" != "1" ]]; then
	say "pre-downloading whisper model '${MODEL}' (one-time, can take a while)"
	if ! "${PY}" - "$MODEL" "${MODELS}" <<'PYEOF'; then
import sys
from faster_whisper import WhisperModel
WhisperModel(sys.argv[1], device="cpu", compute_type="int8", download_root=sys.argv[2])
print("model ready:", sys.argv[1])
PYEOF
		warn "model download failed — it will be downloaded on first use instead"
	fi
fi

# ---------------------------------------------------------------- starter config
if [[ ! -f "${DATA_DIR}/config.json" ]]; then
	cat >"${DATA_DIR}/config.json" <<'JSON'
{
  "transcribe": { "model": "large-v3-turbo", "device": "auto", "computeType": "auto", "language": "auto" },
  "vision":     { "enabled": true, "intervalSec": 30, "maxFrames": 24 },
  "proofread":  { "enabled": true, "applyDictionary": true, "learnToDictionary": true },
  "summary":    { "language": "auto", "imagesInReport": 8 },
  "output":     { "dir": "", "openAfterGenerate": true }
}
JSON
	say "wrote starter config.json (full option set: /video-summary-config)"
fi
[[ -f "${DATA_DIR}/dictionary.json" ]] || echo "[]" >"${DATA_DIR}/dictionary.json"

# ---------------------------------------------------------------- done
cat <<EOF

$(printf '\033[1;32m')✓ video-summary installed$(printf '\033[0m')
  extension : ${EXT_DIR}
  data      : ${DATA_DIR} (venv, models, config, dictionary)
  whisper   : ${MODEL} (GPU: $([[ "${GPU}" == "1" ]] && echo "yes" || echo "no"))

Usage inside pi:
  /video-summary /path/to/video.mp4
  /video-summary "https://www.bilibili.com/video/BV..."
  /video-summary "https://www.youtube.com/watch?v=..."
  /video-summary-config     # adjust every knob
  /video-dict               # inspect the learned correction dictionary

Restart pi or run /reload to pick up the extension.
EOF

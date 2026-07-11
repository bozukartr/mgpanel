#!/usr/bin/env bash
# Firestore Emulator jar'ını indirir (bir kez; ~60MB, git'e girmez).
set -e
cd "$(dirname "$0")"
mkdir -p bin
JAR=bin/firestore-emulator.jar
VER=v1.19.8
if [ ! -s "$JAR" ]; then
  echo "Firestore Emulator $VER indiriliyor…"
  curl -fsSL -o "$JAR" "https://storage.googleapis.com/firebase-preview-drop/emulator/cloud-firestore-emulator-$VER.jar"
fi
echo "Emülatör hazır: $JAR"

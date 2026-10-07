import fcntl
import json
import os
import pty
import select
import signal
import struct
import subprocess
import sys
import termios
import time
import codecs
import unicodedata


class TextScreen:
    def __init__(self, width=80, height=24):
        self.width, self.height = width, height
        self.rows = [[" "] * width for _ in range(height)]
        self.row = self.col = 0
        self.saved = (0, 0)
        self.mode = "text"
        self.control = ""
        self.previous_escape = False

    def feed(self, text):
        for char in text:
            if self.mode in ("osc", "dcs"):
                if char == "\x07" or (self.previous_escape and char == "\\"):
                    self.mode = "text"
                self.previous_escape = char == "\x1b"
                continue
            if self.mode == "escape":
                self.mode = {"[": "csi", "]": "osc", "P": "dcs"}.get(char, "text")
                self.control = ""
                if char == "7": self.saved = (self.row, self.col)
                if char == "8": self.row, self.col = self.saved
                continue
            if self.mode == "csi":
                if "@" <= char <= "~":
                    self.csi(char, self.control)
                    self.mode = "text"
                else:
                    self.control += char
                continue
            if char == "\x1b": self.mode = "escape"
            elif char == "\r": self.col = 0
            elif char == "\n": self.row = min(self.height - 1, self.row + 1)
            elif char == "\b": self.col = max(0, self.col - 1)
            elif char == "\t": self.col = min(self.width - 1, (self.col // 8 + 1) * 8)
            elif char >= " " and not unicodedata.combining(char):
                if self.col >= self.width:
                    self.col = 0
                    self.row = min(self.height - 1, self.row + 1)
                self.rows[self.row][self.col] = char
                self.col += 2 if unicodedata.east_asian_width(char) in ("W", "F") else 1

    def csi(self, command, raw):
        if raw.startswith("?"): return
        values = [int(value) if value.isdigit() else 0 for value in raw.split(";")]
        first = values[0] or 1
        if command in ("H", "f"):
            self.row = max(0, min(self.height - 1, first - 1))
            self.col = max(0, min(self.width - 1, (values[1] if len(values) > 1 and values[1] else 1) - 1))
        elif command == "A": self.row = max(0, self.row - first)
        elif command == "B": self.row = min(self.height - 1, self.row + first)
        elif command == "C": self.col = min(self.width - 1, self.col + first)
        elif command == "D": self.col = max(0, self.col - first)
        elif command == "G": self.col = max(0, min(self.width - 1, first - 1))
        elif command == "d": self.row = max(0, min(self.height - 1, first - 1))
        elif command == "J":
            for row in range(self.height):
                for col in range(self.width):
                    if values[0] in (2, 3) or (values[0] == 0 and (row, col) >= (self.row, self.col)) or (values[0] == 1 and (row, col) <= (self.row, self.col)):
                        self.rows[row][col] = " "
        elif command == "K":
            for col in range(self.width):
                if values[0] == 2 or (values[0] == 0 and col >= self.col) or (values[0] == 1 and col <= self.col):
                    self.rows[self.row][col] = " "

    def text(self):
        return "\n".join("".join(row).rstrip() for row in self.rows)

executable, url, project, output = sys.argv[1:5]
session = sys.argv[5] if len(sys.argv) > 5 else None
master, slave = pty.openpty()
screen = TextScreen()
decoder = codecs.getincrementaldecoder("utf-8")("replace")
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 24, 80, 0, 0))
child = subprocess.Popen([executable, "--server", url, *(["--session", session] if session else []), project], stdin=slave, stdout=slave, stderr=slave, env=os.environ, start_new_session=True)
os.close(slave)
deadline = time.monotonic() + 120
exiting = False
try:
    with open(output, "wb") as log:
        while child.poll() is None and time.monotonic() < deadline:
            ready, _, _ = select.select([master, sys.stdin], [], [], 0.1)
            if master in ready:
                try:
                    data = os.read(master, 65536)
                except OSError:
                    break
                log.write(data)
                log.flush()
                screen.feed(decoder.decode(data))
                with open(output + ".screen.txt", "w") as snapshot:
                    snapshot.write(screen.text())
                if b"\x1b[6n" in data:
                    os.write(master, b"\x1b[1;1R")
                if b"\x1b[c" in data:
                    os.write(master, b"\x1b[?62;22c")
            if sys.stdin in ready:
                line = sys.stdin.readline()
                if not line:
                    break
                command = json.loads(line)
                if command.get("exit"):
                    exiting = True
                    os.write(master, b"\x03\x03")
                    deadline = min(deadline, time.monotonic() + 8)
                elif "keys" in command:
                    os.write(master, command["keys"].encode())
                elif "resize" in command:
                    width, height = command["resize"]
                    screen = TextScreen(width, height)
                    fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack("HHHH", height, width, 0, 0))
                    os.killpg(child.pid, signal.SIGWINCH)
finally:
    if child.poll() is None:
        child.send_signal(signal.SIGTERM)
    try:
        child.wait(timeout=8)
    except subprocess.TimeoutExpired:
        child.kill()
        child.wait()
    os.close(master)
    if not exiting or child.returncode not in (0, -signal.SIGTERM):
        sys.exit(1)

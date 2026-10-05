import pty, os, time, select, signal, fcntl, termios, struct, re, sys
pid, fd = pty.fork()
if pid == 0:
    os.environ["TERM"]="xterm-256color"
    os.execvpe("/Users/linull/.pi/agent/bin/pi", ["pi","--no-session"], os.environ); os._exit(1)
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 34, 100, 0, 0))
buf=bytearray()
def drain(t):
    end=time.time()+t
    while time.time()<end:
        r,_,_=select.select([fd],[],[],0.3)
        if r:
            try: d=os.read(fd,65536)
            except OSError: return
            if not d: return
            buf.extend(d)
def plain():
    raw=bytes(buf).decode(errors="replace"); p=re.sub(r"\x1b\[[0-9;?]*[A-Za-z]","",raw); p=re.sub(r"\x1b\][^\x07]*\x07","",p)
    return p
drain(8)
prompt='Use the ask_user_question tool exactly once. Ask a single question titled "Pick one" with 4 options; each option description must be about 300 characters of distinct lorem-style text. Then stop.'
for ch in prompt: os.write(fd, ch.encode()); time.sleep(0.002)
os.write(fd, b"\r")
# wait for the dialog (look for an option marker)
deadline=time.time()+120
while time.time()<deadline:
    drain(1.0)
    if "Pick one" in plain() or "Submit" in plain(): break
drain(3)
before=plain()
# send wheel-down x6 at a mid-screen cell inside the dialog
for _ in range(6):
    os.write(fd, b"\x1b[<64;50;17M"); time.sleep(0.15)
drain(2)
after=plain()
print("dialog appeared :", ("Pick one" in after) or ("Submit" in after))
print("render changed  :", before != after)
# show a slice around the option area
i=after.rfind("Pick one")
print("---- after (slice) ----")
print(after[i:i+400] if i>=0 else after[-400:])
os.write(fd, b"\x03"); drain(0.5); os.write(fd, b"\x03"); drain(1)
try: os.kill(pid, signal.SIGKILL)
except Exception: pass
try: os.waitpid(pid,0)
except Exception: pass

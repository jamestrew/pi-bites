#!/usr/bin/env python3
"""Exercise the packaged protocol and V8. Usage: script [qemu-aarch64] HOST."""
import json
import selectors
import struct
import subprocess
import sys
import time


def smoke(command):
    process = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    deadline = time.monotonic() + 20
    selector = selectors.DefaultSelector()
    selector.register(process.stdout, selectors.EVENT_READ)
    pending = bytearray()

    def send(message):
        body = json.dumps(message).encode()
        process.stdin.write(struct.pack('<I', len(body)) + body)
        process.stdin.flush()

    def receive(kind, request_id=None):
        while True:
            while len(pending) < 4 or len(pending) < 4 + struct.unpack('<I', pending[:4])[0]:
                if len(pending) >= 4 and struct.unpack('<I', pending[:4])[0] > 65536:
                    raise RuntimeError('oversized host frame')
                if not selector.select(max(0, deadline - time.monotonic())):
                    raise TimeoutError('host smoke timed out')
                chunk = process.stdout.read1(65536)
                if not chunk:
                    raise RuntimeError('host closed stdout')
                pending.extend(chunk)
            length = struct.unpack('<I', pending[:4])[0]
            message = json.loads(pending[4:4 + length])
            del pending[:4 + length]
            if message['type'] == kind and (request_id is None or message.get('id') == request_id):
                return message

    def request(number, method, **fields):
        send({'type': 'operation/request', 'id': number, 'request': {'method': method, 'sessionId': 'smoke', **fields}})
        result = receive('operation/response', number)['result']
        assert result['status'] == 'ok', result
        return result['value']

    try:
        send({'type': 'connection/hello', 'supportedVersions': [1], 'requiredCapabilities': [], 'optionalCapabilities': []})
        assert receive('connection/ready')['selectedVersion'] == 1
        assert request(1, 'session/open')['type'] == 'session/ready'
        assert request(2, 'session/execute', request={'tool_call_id': 'smoke', 'enabled_tools': [], 'source': 'text(6 * 7)', 'yield_time_ms': 1000, 'max_output_tokens': 100})['type'] == 'execution/started'
        response = receive('execute/initialResponse', 2)['result']
        assert response['status'] == 'ok', response
        result = response['value']['Result']
        assert result['error_text'] is None, result
        assert result['content_items'] == [{'type': 'input_text', 'text': '42'}], result
        assert request(3, 'session/shutdown')['type'] == 'session/closed'
        process.stdin.close()
        assert process.wait(timeout=5) == 0
        print('PASS: protocol v1, V8 execution, session shutdown, clean exit')
    finally:
        selector.close()
        if process.poll() is None:
            process.kill()
        process.wait()


if __name__ == '__main__':
    smoke(sys.argv[1:])

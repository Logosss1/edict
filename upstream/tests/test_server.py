"""tests for dashboard/server.py route handling"""
import json, pathlib, sys, threading
from http.client import HTTPConnection

# Add project paths
ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / 'dashboard'))
sys.path.insert(0, str(ROOT / 'scripts'))


def test_healthz(tmp_path, monkeypatch):
    """GET /healthz returns 200 with status ok."""
    # Create minimal data dir
    data_dir = tmp_path / 'data'
    data_dir.mkdir()
    (data_dir / 'live_status.json').write_text('{}')
    (data_dir / 'agent_config.json').write_text('{}')

    # Import and patch server
    import server as srv
    monkeypatch.setattr(srv, 'DATA', data_dir)

    from http.server import HTTPServer
    httpd = HTTPServer(('127.0.0.1', 0), srv.Handler)
    t = threading.Thread(target=httpd.handle_request, daemon=True)
    t.start()

    conn = HTTPConnection('127.0.0.1', httpd.server_port, timeout=5)
    try:
        conn.request('GET', '/healthz')
        resp = conn.getresponse()
        body = json.loads(resp.read())
        assert resp.status == 200
        assert body['status'] in ('ok', 'degraded')
    finally:
        conn.close()
        t.join(timeout=5)
        httpd.server_close()

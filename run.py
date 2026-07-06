import http.server
import socketserver
import webbrowser
import threading
import time
import os
import sys

PORT = 8000
DIRECTORY = os.path.dirname(os.path.abspath(__file__))

class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=DIRECTORY, **kwargs)

def start_server():
    # Allow port reuse to avoid 'Address already in use' errors
    socketserver.TCPServer.allow_reuse_address = True
    with socketserver.TCPServer(("", PORT), Handler) as httpd:
        print(f"\n[START] AeroCanvas Server started successfully at http://localhost:{PORT}")
        print("[INFO] Keep this terminal window open to run the application.")
        print("[INFO] Press Ctrl+C in this terminal to shut down the server.\n")
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            pass

def main():
    print("=" * 60)
    print("               AEROCANVAS AI LAUNCHER")
    print("=" * 60)
    print("Initializing server...")
    
    # Start local HTTP server in a daemon thread so it exits when main program exits
    server_thread = threading.Thread(target=start_server, daemon=True)
    server_thread.start()
    
    # Wait a brief moment for the server to spin up
    time.sleep(1.0)
    
    # Open URL in default browser
    url = f"http://localhost:{PORT}"
    print(f"Opening {url} in your default browser...")
    webbrowser.open(url)
    
    # Keep the main process alive so the thread doesn't terminate
    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        print("\nStopping AeroCanvas Server... Goodbye!")
        sys.exit(0)

if __name__ == "__main__":
    main()

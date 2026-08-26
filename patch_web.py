import re

with open("index.html", "r") as f:
    content = f.read()

admin_section = """
    <section id="admin-view" class="view" hidden>
      <div class="page-heading">
        <p class="eyebrow">Admin</p>
        <h1>Dashboard</h1>
        <p>Manage devices and view network activity.</p>
      </div>
      <div id="admin-linking" class="admin-panel" hidden>
        <h2>Device Linking Request</h2>
        <p id="admin-link-text">A new device wants to connect.</p>
        <button id="admin-approve-btn" class="primary-button">Approve Device</button>
      </div>
      <div id="admin-activity" class="admin-panel">
        <h2>Currently Watching</h2>
        <div id="admin-activity-list" class="grid-list"></div>
      </div>
    </section>
"""

# Insert admin-view before roadmaps-view
if "id=\"admin-view\"" not in content:
    content = content.replace("    <section id=\"roadmaps-view\"", admin_section + "    <section id=\"roadmaps-view\"")
    with open("index.html", "w") as f:
        f.write(content)
    print("Patched index.html")
else:
    print("index.html already patched")

with open("app.js", "r") as f:
    app_js = f.read()

# Add admin route handling
if "adminView.hidden = route !== 'admin';" not in app_js:
    # 1. find libraryView = byId('library-view') and add adminView
    app_js = app_js.replace("const libraryView = byId('library-view');", "const libraryView = byId('library-view');\\nconst adminView = byId('admin-view');")
    
    # 2. find libraryView.hidden = route !== 'library'; and add adminView
    app_js = app_js.replace("libraryView.hidden = route !== 'library';", "libraryView.hidden = route !== 'library';\\n  adminView.hidden = route !== 'admin' && route !== 'link';")
    
    with open("app.js", "w") as f:
        f.write(app_js)
    print("Patched app.js")
else:
    print("app.js already patched")


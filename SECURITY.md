# Security Policy

Pi Web Dock runs a coding agent that can read files and execute commands with your user's permissions. Treat access to its web interface as access to your account on that machine.

## Supported versions

Security fixes are made on the repository’s default branch.

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub's [private vulnerability reporting](https://github.com/zhtordinary/pi-web-dock/security/advisories/new) for this repository. Include the affected version, your platform, reproduction steps, and the impact you observed. Do not include real credentials or private session files.

You should receive an acknowledgement within seven days. Please do not disclose the issue publicly until a fix has been released or we have agreed on a date.

## Deployment guidance

- The server listens on `127.0.0.1` by default. Keep it that way unless you need remote access.
- For remote access, set a long random `PI_WEB_PASSWORD` and put the server behind HTTPS on a trusted reverse proxy or VPN. Password authentication alone does not encrypt traffic.
- Peers can open and control sessions on each other. Server-to-server peer requests do not forward browser credentials, so peers protected by `PI_WEB_PASSWORD` cannot currently be aggregated. Use peers only between instances you control on a trusted, access-restricted network; never expose unauthenticated instances to the internet.
- Keep Node.js and Pi Web Dock up to date.

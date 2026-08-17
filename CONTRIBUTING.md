# Contributing to Linear Autopilot

Thank you for your interest in contributing to Linear Autopilot! This document provides guidelines and instructions for contributing.

## Code of Conduct

Please be respectful and constructive in all interactions. We're building something together.

## Getting Started

### Prerequisites

- Node.js 20+
- [Claude Code CLI](https://github.com/anthropics/claude-code) installed and authenticated
- [GitHub CLI](https://cli.github.com/) (`gh`) authenticated
- A Linear account with API access

### Development Setup

1. **Fork and clone the repository:**

   ```bash
   git clone https://github.com/YOUR_USERNAME/linear-autopilot.git
   cd linear-autopilot
   ```

2. **Install dependencies:**

   ```bash
   npm install
   ```

3. **Set up environment:**

   ```bash
   cp .env.example .env
   # Edit .env with your credentials
   ```

4. **Run in development mode:**

   ```bash
   npm run dev
   ```

5. **Run tests:**
   ```bash
   npm test
   ```

## How to Contribute

### Reporting Bugs

- Check existing issues first to avoid duplicates
- Open an issue describing the bug
- Include reproduction steps, expected vs actual behavior
- Include your environment details (Node version, OS, etc.)

### Suggesting Features

- Open an issue describing the feature request
- Describe the use case and expected behavior
- Be open to discussion about implementation approaches

### Submitting Pull Requests

1. **Create a feature branch:**

   ```bash
   git checkout -b feature/your-feature-name
   ```

2. **Make your changes:**
   - Follow the existing code style
   - Add tests for new functionality
   - Update documentation as needed

3. **Run checks locally:**

   ```bash
   npm run lint
   npm run typecheck
   npm test
   ```

4. **Commit with a descriptive message:**

   ```bash
   git commit -m "feat: add support for custom validation commands"
   ```

   We follow [Conventional Commits](https://www.conventionalcommits.org/):
   - `feat:` — New features
   - `fix:` — Bug fixes
   - `docs:` — Documentation changes
   - `refactor:` — Code refactoring
   - `test:` — Adding or updating tests
   - `chore:` — Maintenance tasks

5. **Push and open a PR:**
   ```bash
   git push origin feature/your-feature-name
   ```

### PR Guidelines

- Link related issues in the PR description
- Keep PRs focused — one feature or fix per PR
- Run `npm run lint`, `npm run typecheck`, and `npm test` locally before pushing
- Be responsive to review feedback

## Project Structure

```
src/
├── config/          # Environment and tenant configuration
├── dashboard/       # Web dashboard and API
├── linear/          # Linear API client with rate limiting
├── logger/          # Structured JSON logging
├── memory/          # Cross-session learning storage
├── notifications/   # Multi-provider notification system
├── prompts/         # Agent prompt templates
├── server/          # Express server and webhooks
├── spawner/         # Agent pool and queue management
├── tracking/        # Cost and token tracking
├── validation/      # Test/lint/typecheck pipeline
└── watcher/         # Webhook and polling handlers
```

## Testing

- **Unit tests:** Test individual functions and classes
- **Integration tests:** Test interactions between components
- **E2E tests:** Test full workflows (webhook → agent → PR)

Run tests:

```bash
npm test                    # Run all tests
npm run test:watch          # Watch mode
npm run test:coverage       # With coverage report
```

### Coverage Requirements

Please maintain the minimum **70% coverage** threshold for:

- Statements
- Branches
- Functions
- Lines

`npm run test:coverage` enforces this locally and will fail if coverage drops
below the threshold, so run it before pushing.

## Code Style

- We use TypeScript with strict mode
- ESLint and Prettier for formatting
- Run `npm run lint` before committing

## Questions?

- Open a discussion on GitHub
- Check existing issues and discussions first

Thank you for contributing! 🚀

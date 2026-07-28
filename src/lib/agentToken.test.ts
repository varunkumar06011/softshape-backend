import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import jwt from 'jsonwebtoken';
import {
  signAgentToken,
  verifyAgentToken,
  decodeAgentToken,
  AGENT_JWT_SECRET,
} from './agentToken';

// ─────────────────────────────────────────────────────────────────────────────
// Tests for agent token refresh flow
//
// These tests verify the core JWT operations that the POST /api/edge/refresh-session
// endpoint relies on:
//   1. signAgentToken creates a valid JWT
//   2. verifyAgentToken rejects expired tokens (normal flow)
//   3. jwt.verify with ignoreExpiration succeeds on expired tokens (refresh flow)
//   4. decodeAgentToken extracts payload without verification
//   5. Tokens signed with the wrong secret are rejected even with ignoreExpiration
//   6. Only "agent-session" purpose tokens should be refreshable
// ─────────────────────────────────────────────────────────────────────────────

describe('agentToken — refresh flow', () => {
  const restaurantId = 'test-restaurant-123';
  const deviceId = 'edge-device-001';

  describe('signAgentToken + verifyAgentToken (normal flow)', () => {
    it('should sign and verify a valid agent-session token', () => {
      const token = signAgentToken(
        { restaurantId, purpose: 'agent-session', agentId: deviceId },
        '1h',
      );

      const payload = verifyAgentToken(token);
      expect(payload.restaurantId).toBe(restaurantId);
      expect(payload.purpose).toBe('agent-session');
      expect(payload.agentId).toBe(deviceId);
    });

    it('should throw on expired tokens (normal verify)', () => {
      const token = signAgentToken(
        { restaurantId, purpose: 'agent-session', agentId: deviceId },
        '-1s', // already expired
      );

      expect(() => verifyAgentToken(token)).toThrow();
    });
  });

  describe('jwt.verify with ignoreExpiration (refresh flow)', () => {
    it('should verify an expired token with ignoreExpiration: true', () => {
      const token = signAgentToken(
        { restaurantId, purpose: 'agent-session', agentId: deviceId },
        '-1s', // already expired
      );

      // This is what the refresh-session endpoint does
      const payload = jwt.verify(token, AGENT_JWT_SECRET, {
        ignoreExpiration: true,
      }) as any;

      expect(payload.restaurantId).toBe(restaurantId);
      expect(payload.purpose).toBe('agent-session');
      expect(payload.agentId).toBe(deviceId);
    });

    it('should reject a token signed with the wrong secret even with ignoreExpiration', () => {
      const token = jwt.sign(
        { restaurantId, purpose: 'agent-session', agentId: deviceId },
        'wrong-secret',
        { expiresIn: '-1s' },
      );

      expect(() => {
        jwt.verify(token, AGENT_JWT_SECRET, { ignoreExpiration: true });
      }).toThrow();
    });

    it('should reject a tampered token even with ignoreExpiration', () => {
      const token = signAgentToken(
        { restaurantId, purpose: 'agent-session', agentId: deviceId },
        '-1s',
      );

      // Tamper with the payload
      const parts = token.split('.');
      const tamperedPayload = Buffer.from(
        JSON.stringify({ restaurantId: 'hacked', purpose: 'agent-session' }),
      ).toString('base64url');
      const tamperedToken = `${parts[0]}.${tamperedPayload}.${parts[2]}`;

      expect(() => {
        jwt.verify(tamperedToken, AGENT_JWT_SECRET, {
          ignoreExpiration: true,
        });
      }).toThrow();
    });
  });

  describe('decodeAgentToken', () => {
    it('should decode payload from an expired token without verification', () => {
      const token = signAgentToken(
        { restaurantId, purpose: 'agent-session', agentId: deviceId },
        '-1s',
      );

      const payload = decodeAgentToken(token);
      expect(payload).not.toBeNull();
      expect(payload!.restaurantId).toBe(restaurantId);
      expect(payload!.purpose).toBe('agent-session');
    });

    it('should return null for a completely invalid string', () => {
      const payload = decodeAgentToken('not-a-jwt');
      expect(payload).toBeNull();
    });
  });

  describe('Token purpose validation (refresh guard)', () => {
    it('agent-setup tokens should have purpose "agent-setup"', () => {
      const token = signAgentToken(
        { restaurantId, purpose: 'agent-setup', agentId: deviceId },
        '10m',
      );

      const payload = jwt.verify(token, AGENT_JWT_SECRET, {
        ignoreExpiration: true,
      }) as any;

      expect(payload.purpose).toBe('agent-setup');
      // The refresh endpoint should reject these:
      expect(payload.purpose).not.toBe('agent-session');
    });

    it('agent-session tokens should have purpose "agent-session"', () => {
      const token = signAgentToken(
        { restaurantId, purpose: 'agent-session', agentId: deviceId },
        '30d',
      );

      const payload = jwt.verify(token, AGENT_JWT_SECRET, {
        ignoreExpiration: true,
      }) as any;

      expect(payload.purpose).toBe('agent-session');
    });
  });

  describe('Refresh token issuance (simulating refresh-session endpoint)', () => {
    it('should issue a new valid token from an expired token payload', () => {
      // Step 1: Create an expired token (simulating what the edge server has)
      const expiredToken = signAgentToken(
        { restaurantId, purpose: 'agent-session', agentId: deviceId },
        '-1s',
      );

      // Step 2: Verify with ignoreExpiration (what the endpoint does)
      const payload = jwt.verify(expiredToken, AGENT_JWT_SECRET, {
        ignoreExpiration: true,
      }) as any;

      expect(payload.purpose).toBe('agent-session');

      // Step 3: Issue a fresh token
      const newToken = signAgentToken(
        {
          restaurantId: payload.restaurantId,
          purpose: 'agent-session',
          agentId: payload.agentId,
        },
        '30d',
      );

      // Step 4: The new token should be valid
      const newPayload = verifyAgentToken(newToken);
      expect(newPayload.restaurantId).toBe(restaurantId);
      expect(newPayload.purpose).toBe('agent-session');
      expect(newPayload.agentId).toBe(deviceId);
    });
  });
});

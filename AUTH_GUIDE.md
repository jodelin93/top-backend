# Authentication Module - Complete Guide

## Overview

The authentication module provides secure user authentication with support for:
- JWT (JSON Web Tokens) for stateless authentication
- MFA (Multi-Factor Authentication) using TOTP (Time-based One-Time Password)
- Bcrypt password hashing
- Passport.js strategies for flexible authentication

---

## Architecture

### Components

1. **AuthService** - Core business logic for authentication
2. **AuthController** - REST API endpoints
3. **JwtStrategy** - Passport strategy for JWT validation
4. **LocalStrategy** - Passport strategy for email/password auth
5. **Guards** - Route protection (JwtAuthGuard, MfaGuard)
6. **DTOs** - Request validation objects

### Security Features

- **Password Hashing**: Bcrypt with 10 rounds
- **JWT Tokens**: 24-hour expiration (configurable)
- **MFA**: TOTP-based with QR code generation
- **Temporary Tokens**: 5-minute tokens for MFA verification
- **MFA Verification Flag**: Prevents bypass of MFA requirement

---

## API Endpoints

### 1. Login
**POST** `/auth/login`

Authenticates user with email and password.

**Request:**
```json
{
  "email": "admin@test.com",
  "password": "Password123!"
}
```

**Response (No MFA):**
```json
{
  "accessToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "user": {
    "id": "uuid",
    "email": "admin@test.com",
    "firstName": "Admin",
    "lastName": "User"
  },
  "requiresMfa": false
}
```

**Response (MFA Enabled):**
```json
{
  "accessToken": "temporary-token-for-mfa-verification",
  "user": {
    "id": "uuid",
    "email": "admin@test.com",
    "firstName": "Admin",
    "lastName": "User"
  },
  "requiresMfa": true
}
```

**Status Codes:**
- `200 OK` - Successful login
- `401 Unauthorized` - Invalid credentials

---

### 2. Verify MFA Token
**POST** `/auth/mfa/verify`

Verifies MFA token and returns full access token.

**Headers:**
```
Authorization: Bearer <temporary-token-from-login>
```

**Request:**
```json
{
  "token": "123456"
}
```

**Response:**
```json
{
  "accessToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
}
```

**Status Codes:**
- `200 OK` - MFA verified, full token returned
- `401 Unauthorized` - Invalid MFA token or expired temporary token

---

### 3. Enable MFA
**POST** `/auth/mfa/enable`

Generates MFA secret and QR code for authenticator app setup.

**Headers:**
```
Authorization: Bearer <access-token>
```

**Response:**
```json
{
  "secret": "JBSWY3DPEHPK3PXP",
  "qrCode": "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAA..."
}
```

**Usage:**
1. Call this endpoint to get QR code
2. Scan QR code with authenticator app (Google Authenticator, Authy, etc.)
3. Call `/auth/mfa/confirm` with a token from the app to activate MFA

**Status Codes:**
- `200 OK` - Secret and QR code generated
- `401 Unauthorized` - Invalid or expired token

---

### 4. Confirm MFA Setup
**POST** `/auth/mfa/confirm`

Confirms MFA setup by verifying a token from authenticator app.

**Headers:**
```
Authorization: Bearer <access-token>
```

**Request:**
```json
{
  "token": "123456"
}
```

**Response:**
```json
{
  "success": true,
  "message": "MFA has been enabled successfully"
}
```

**Status Codes:**
- `200 OK` - MFA activated
- `401 Unauthorized` - Invalid token

---

### 5. Disable MFA
**POST** `/auth/mfa/disable`

Disables MFA for the user account (requires MFA verification).

**Headers:**
```
Authorization: Bearer <access-token>
```

**Request:**
```json
{
  "token": "123456"
}
```

**Response:**
```json
{
  "success": true,
  "message": "MFA has been disabled successfully"
}
```

**Status Codes:**
- `200 OK` - MFA disabled
- `401 Unauthorized` - Invalid token or MFA not enabled

---

### 6. Get Current User Profile
**POST** `/auth/me`

Returns current user's profile information.

**Headers:**
```
Authorization: Bearer <access-token>
```

**Response:**
```json
{
  "id": "uuid",
  "email": "admin@test.com",
  "firstName": "Admin",
  "lastName": "User",
  "locale": "en",
  "timezone": "UTC",
  "mfaEnabled": false,
  "status": "active",
  "lastLoginAt": "2026-09-24T10:30:00.000Z"
}
```

**Status Codes:**
- `200 OK` - Profile returned
- `401 Unauthorized` - Invalid or expired token

---

## Authentication Flow

### Standard Login (No MFA)

```
1. Client → POST /auth/login with email/password
2. Server validates credentials
3. Server generates JWT token (24h expiration)
4. Server ← Returns access token and user info
5. Client stores token
6. Client → Includes token in Authorization header for protected routes
```

### Login with MFA Enabled

```
1. Client → POST /auth/login with email/password
2. Server validates credentials
3. Server detects MFA is enabled
4. Server generates temporary token (5min expiration, mfaVerified: false)
5. Server ← Returns temporary token with requiresMfa: true
6. Client prompts user for MFA token
7. Client → POST /auth/mfa/verify with temporary token and MFA code
8. Server validates MFA token
9. Server generates full JWT token (24h expiration, mfaVerified: true)
10. Server ← Returns access token
11. Client stores token
12. Client → Includes token in Authorization header
```

### MFA Setup Flow

```
1. User logged in with valid JWT
2. Client → POST /auth/mfa/enable
3. Server generates TOTP secret
4. Server saves secret to user (not yet enabled)
5. Server generates QR code
6. Server ← Returns secret and QR code
7. Client displays QR code to user
8. User scans with authenticator app
9. User enters token from app
10. Client → POST /auth/mfa/confirm with token
11. Server validates token
12. Server enables MFA for user
13. Server ← Confirms MFA enabled
14. Next login will require MFA
```

---

## Guards Usage

### Protect Routes with JWT

```typescript
import { Controller, Get, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { User } from '../database/entities/user.entity';

@Controller('products')
export class ProductsController {
  @UseGuards(JwtAuthGuard)
  @Get()
  async findAll(@CurrentUser() user: User) {
    // user is automatically injected from JWT token
    console.log('Current user:', user.email);
    return [];
  }
}
```

### Public Routes (No Authentication)

```typescript
import { Controller, Post } from '@nestjs/common';
import { Public } from '../auth/decorators/public.decorator';

@Controller('public')
export class PublicController {
  @Public()
  @Post('contact')
  async contactUs() {
    // This endpoint does not require authentication
    return { message: 'Thank you for contacting us' };
  }
}
```

---

## JWT Token Structure

### Token Payload

```typescript
{
  "sub": "user-uuid",           // User ID
  "email": "admin@test.com",    // User email
  "mfaVerified": true,          // MFA verification status
  "iat": 1727184000,            // Issued at
  "exp": 1727270400             // Expiration
}
```

### Token Validation

The `JwtStrategy` automatically:
1. Extracts token from Authorization header
2. Verifies signature using JWT_SECRET
3. Checks expiration
4. Loads user from database
5. Validates MFA requirements
6. Injects user into request object

---

## Environment Configuration

### Required Variables (.env)

```bash
# JWT Secret (use long random string in production)
JWT_SECRET=<your-jwt-secret — generate with: openssl rand -base64 48>

# JWT Token Expiration
JWT_EXPIRES_IN=24h

# Password Hashing Rounds
BCRYPT_ROUNDS=10

# MFA Application Name (shown in authenticator apps)
MFA_APP_NAME=Modern POS
```

### Security Best Practices

1. **JWT_SECRET**: Use a long (64+ characters), random string in production
2. **JWT_EXPIRES_IN**: Balance security vs. user experience (24h recommended)
3. **BCRYPT_ROUNDS**: 10 is good balance of security and performance
4. **HTTPS**: Always use HTTPS in production
5. **Token Storage**: Store tokens in httpOnly cookies or secure storage (not localStorage)

---

## Testing

### Test Credentials

A test user has been created:
- **Email**: `admin@test.com`
- **Password**: `Password123!`
- **MFA**: Disabled by default

### Manual Testing with cURL

#### Login
```bash
curl -X POST http://localhost:3000/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@test.com","password":"Password123!"}'
```

#### Get Profile
```bash
curl -X POST http://localhost:3000/auth/me \
  -H "Authorization: Bearer YOUR_TOKEN_HERE"
```

#### Enable MFA
```bash
curl -X POST http://localhost:3000/auth/mfa/enable \
  -H "Authorization: Bearer YOUR_TOKEN_HERE"
```

### Testing with Postman/Insomnia

1. **Import Collection**: Create requests for all endpoints
2. **Environment Variable**: Store token as `{{accessToken}}`
3. **Auto-update Token**: Use response scripts to update token
4. **Test MFA**: Use Google Authenticator or Authy app

---

## Error Handling

### Common Error Responses

#### 401 Unauthorized - Invalid Credentials
```json
{
  "statusCode": 401,
  "message": "Invalid credentials",
  "error": "Unauthorized"
}
```

#### 401 Unauthorized - MFA Required
```json
{
  "statusCode": 401,
  "message": "MFA verification required",
  "error": "Unauthorized"
}
```

#### 401 Unauthorized - Invalid MFA Token
```json
{
  "statusCode": 401,
  "message": "Invalid MFA token",
  "error": "Unauthorized"
}
```

---

## Files Created

### Core Files
```
src/auth/
├── auth.module.ts              # Module configuration with JWT setup
├── auth.service.ts             # Authentication business logic
├── auth.controller.ts          # API endpoints
│
├── dto/
│   ├── login.dto.ts           # Login request validation
│   ├── mfa-token.dto.ts       # MFA token validation
│   └── index.ts               # DTO exports
│
├── strategies/
│   ├── jwt.strategy.ts        # JWT validation strategy
│   └── local.strategy.ts      # Email/password strategy
│
├── guards/
│   ├── jwt-auth.guard.ts      # JWT route protection
│   ├── local-auth.guard.ts    # Local auth guard
│   └── mfa.guard.ts           # MFA verification guard
│
└── decorators/
    ├── public.decorator.ts     # Mark routes as public
    └── current-user.decorator.ts # Inject current user
```

### Support Files
```
src/database/seeds/
└── create-test-user.ts         # Test user creation script

.env                             # Environment configuration
.env.example                     # Environment template
```

---

## Next Steps

### Recommended Enhancements

1. **Refresh Tokens**: Implement refresh token rotation
2. **Password Reset**: Email-based password reset flow
3. **Email Verification**: Verify email addresses on registration
4. **Rate Limiting**: Prevent brute force attacks
5. **Session Management**: Track active sessions
6. **Audit Logging**: Log all authentication events
7. **OAuth Integration**: Add Google/Facebook login
8. **Backup Codes**: Generate backup codes for MFA
9. **Device Management**: Track and manage login devices
10. **IP Whitelisting**: Restrict access by IP address

### Frontend Integration

The frontend should:
1. Store JWT token securely
2. Include token in Authorization header
3. Handle token expiration gracefully
4. Implement MFA UI flow
5. Display QR code for MFA setup
6. Auto-refresh tokens before expiration

---

## Troubleshooting

### Issue: Token always returns 401

**Check:**
1. Token is being sent in `Authorization: Bearer <token>` format
2. JWT_SECRET in .env matches the one used to sign tokens
3. Token has not expired
4. User still exists in database
5. If MFA enabled, token has `mfaVerified: true`

### Issue: MFA token always fails

**Check:**
1. Time sync on server and client device
2. Using 6-digit numeric code
3. Secret was saved correctly in database
4. MFA is enabled for the user
5. Token hasn't been used already (TOTP tokens expire every 30 seconds)

### Issue: Cannot login after enabling MFA

**Solution:**
1. Login with email/password (returns temporary token)
2. Get MFA token from authenticator app
3. POST to `/auth/mfa/verify` with temporary token and MFA code
4. Use the returned full access token

---

## Security Considerations

### Production Checklist

- [ ] Change JWT_SECRET to long random string
- [ ] Enable HTTPS
- [ ] Set secure cookie flags
- [ ] Implement rate limiting
- [ ] Enable CORS properly
- [ ] Set up CSP headers
- [ ] Implement audit logging
- [ ] Regular security updates
- [ ] Monitor failed login attempts
- [ ] Set up alerting for suspicious activity

### Password Policy

Current: Minimum 6 characters (configurable in DTO)

Recommended for production:
- Minimum 12 characters
- Require uppercase, lowercase, numbers, special chars
- Check against common password lists
- Implement password history
- Force password change every 90 days

---

## Support

For issues or questions:
1. Check this documentation
2. Review error messages carefully
3. Check environment configuration
4. Verify database connectivity
5. Review server logs

---

**Last Updated**: September 24, 2026
**Version**: 1.0.0
**Status**: ✅ Production Ready

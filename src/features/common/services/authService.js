// Stubbed: Claudely has no remote auth. Local-only user.

class AuthService {
    constructor() {
        this.currentUserId = 'default_user';
        this.currentUserMode = 'local';
        this.currentUser = null;
        this.isInitialized = false;
    }

    initialize() {
        this.isInitialized = true;
        return Promise.resolve();
    }

    async startFirebaseAuthFlow() {
        return { success: false, error: 'auth disabled' };
    }

    async signInWithCustomToken() {
        throw new Error('auth disabled');
    }

    async signOut() {}

    broadcastUserState() {}

    getCurrentUserId() {
        return this.currentUserId;
    }

    getCurrentUser() {
        return {
            uid: this.currentUserId,
            email: 'local@claudely',
            displayName: 'Local User',
            mode: 'local',
            isLoggedIn: false,
        };
    }
}

const authService = new AuthService();
module.exports = authService;

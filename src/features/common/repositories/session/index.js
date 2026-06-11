const sqliteRepository = require('./sqlite.repository');

let authService = null;

function setAuthService(service) {
    authService = service;
}

function getAuthService() {
    if (!authService) {
        authService = require('../../services/authService');
    }
    return authService;
}

function getBaseRepository() {
    return sqliteRepository;
}

// The adapter layer that injects the UID
const sessionRepositoryAdapter = {
    setAuthService, // Expose the setter

    getById: (id) => getBaseRepository().getById(id),
    
    create: (type = 'ask') => {
        const uid = getAuthService().getCurrentUserId();
        return getBaseRepository().create(uid, type);
    },
    
    getAllByUserId: () => {
        const uid = getAuthService().getCurrentUserId();
        return getBaseRepository().getAllByUserId(uid);
    },

    updateTitle: (id, title) => getBaseRepository().updateTitle(id, title),
    
    deleteWithRelatedData: (id) => getBaseRepository().deleteWithRelatedData(id),

    end: (id) => getBaseRepository().end(id),

    updateType: (id, type) => getBaseRepository().updateType(id, type),

    touch: (id) => getBaseRepository().touch(id),

    getOrCreateActive: (requestedType = 'ask') => {
        const uid = getAuthService().getCurrentUserId();
        return getBaseRepository().getOrCreateActive(uid, requestedType);
    },

    endAllActiveSessions: () => {
        const uid = getAuthService().getCurrentUserId();
        return getBaseRepository().endAllActiveSessions(uid);
    },

    getClaudeContext: (id) => getBaseRepository().getClaudeContext(id),
    setClaudeContext: (id, ctx) => getBaseRepository().setClaudeContext(id, ctx),
};

module.exports = sessionRepositoryAdapter; 
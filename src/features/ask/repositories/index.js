const sqliteRepository = require('./sqlite.repository');
const authService = require('../../common/services/authService');

function getBaseRepository() {
    return sqliteRepository;
}

const askRepositoryAdapter = {
    addAiMessage: ({ sessionId, role, content, model }) => {
        const uid = authService.getCurrentUserId();
        return getBaseRepository().addAiMessage({ uid, sessionId, role, content, model });
    },
    getAllAiMessagesBySessionId: (sessionId) => {
        return getBaseRepository().getAllAiMessagesBySessionId(sessionId);
    }
};

module.exports = askRepositoryAdapter;

'use strict';

var Promise = require('bluebird');

// EXPORTS
// =============================================================================

/**
* Finds the oldest build which is not successful and have 5 or less build attempts
*
* @param {Object} db - the db object returned from mongodb.connect()
*/
exports.next = function (db) {
  return new Promise(function (resolve, reject) {
    db.collection('buildqueue')
      .find(
        {isSuccessful: false, nrOfAttempts: {$lt: 5}},
        {limit: 1, sort: [['createdAt', 'ascending']]}
      )
      .toArrayAsync()
      .spread(resolve)
      .catch(reject);
  });
};

/**
* Updates the given buildContext (buildqueue item)
*
* @param {Object} db - the db object returned from mongodb.connect()
* @param {Object} buildContext - the buildqueue item to update
*/
exports.update = function (db, buildContext) {
  return new Promise(function (resolve, reject) {
    var buildqueue = db.collection('buildqueue');
    if (buildContext.isSuccessful) {
      // update any other builds for the same repo.
      buildqueue.updateAsync(
      {
        repo: buildContext.repo,
        commit: buildContext.commit,
        isSuccessful: false,
        _id: {$ne: buildContext._id}
      },
      {
        $set: {
          isSuccessful: true,
          message: 'cleared by other build with same commit',
          buildAt: buildContext.buildAt
        }
      },
      {w: 1})
        .then(function() {
          // update the buildqueue item
          return update(buildqueue, buildContext)
            .then(resolve);
        });

    } else {
      // update the buildqueue item
      return update(buildqueue, buildContext)
        .then(resolve);
    }
  });

  function update (buildqueue, buildContext) {
    return buildqueue.updateAsync({_id: buildContext._id}, buildContext, {w: 1})
      .then(function () {
        return buildContext;
      });
  }
};

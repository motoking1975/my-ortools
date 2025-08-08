function setDeploymentId() {
  const DEPLOYMENT_ID = 'AKfycbyoy4PpPzkb707mvRA7vdcdmQG8Kt0zAhkQz7puqKo';
  const props = PropertiesService.getScriptProperties();
  props.setProperty('DEPLOYMENT_ID', DEPLOYMENT_ID);
  Logger.log('DEPLOYMENT_ID がスクリプトプロパティに設定されました: ' + DEPLOYMENT_ID);
}

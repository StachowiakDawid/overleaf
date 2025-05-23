import { useState, useEffect, useLayoutEffect } from 'react'
import { UserEmailData } from '../../../../../../types/user-email'
import getMeta from '../../../../utils/meta'
import ReconfirmationInfoSuccess from './reconfirmation-info/reconfirmation-info-success'
import ReconfirmationInfoPromptText from './reconfirmation-info/reconfirmation-info-prompt-text'
import OLRow from '@/features/ui/components/ol/ol-row'
import OLCol from '@/features/ui/components/ol/ol-col'
import OLNotification from '@/features/ui/components/ol/ol-notification'
import { useUserEmailsContext } from '@/features/settings/context/user-email-context'
import { FetchError, postJSON } from '@/infrastructure/fetch-json'
import { debugConsole } from '@/utils/debugging'
import { ssoAvailableForInstitution } from '@/features/settings/utils/sso'
import { Trans, useTranslation } from 'react-i18next'
import useAsync from '@/shared/hooks/use-async'
import { useLocation } from '@/shared/hooks/use-location'
import OLButton from '@/features/ui/components/ol/ol-button'
import LoadingSpinner from '@/shared/components/loading-spinner'

type ReconfirmationInfoProps = {
  userEmailData: UserEmailData
}

function ReconfirmationInfo({ userEmailData }: ReconfirmationInfoProps) {
  const reconfirmedViaSAML = getMeta('ol-reconfirmedViaSAML')

  const { t } = useTranslation()
  const { samlInitPath } = getMeta('ol-ExposedSettings')
  const { error, isLoading, isError, isSuccess, runAsync } = useAsync()
  const { state, setLoading: setUserEmailsContextLoading } =
    useUserEmailsContext()
  const [hasSent, setHasSent] = useState(false)
  const [isPending, setIsPending] = useState(false)
  const location = useLocation()
  const ssoAvailable = Boolean(
    ssoAvailableForInstitution(userEmailData.affiliation?.institution ?? null)
  )

  const handleRequestReconfirmation = () => {
    if (userEmailData.affiliation?.institution && ssoAvailable) {
      setIsPending(true)
      location.assign(
        `${samlInitPath}?university_id=${userEmailData.affiliation.institution.id}&reconfirm=/user/settings`
      )
    } else {
      runAsync(
        postJSON('/user/emails/send-reconfirmation', {
          body: {
            email: userEmailData.email,
          },
        })
      ).catch(debugConsole.error)
    }
  }

  useEffect(() => {
    setUserEmailsContextLoading(isLoading)
  }, [setUserEmailsContextLoading, isLoading])

  useLayoutEffect(() => {
    if (isSuccess) {
      setHasSent(true)
    }
  }, [isSuccess])

  const rateLimited =
    isError && error instanceof FetchError && error.response?.status === 429

  if (!userEmailData.affiliation) {
    return null
  }

  if (
    userEmailData.samlProviderId &&
    userEmailData.samlProviderId === reconfirmedViaSAML
  ) {
    return (
      <OLRow>
        <OLCol lg={12}>
          <OLNotification
            type="info"
            content={
              <ReconfirmationInfoSuccess
                institution={userEmailData.affiliation.institution}
              />
            }
          />
        </OLCol>
      </OLRow>
    )
  }

  if (userEmailData.affiliation.inReconfirmNotificationPeriod) {
    return (
      <OLRow>
        <OLCol lg={12}>
          <OLNotification
            type="info"
            content={
              <>
                {hasSent ? (
                  <Trans
                    i18nKey="please_check_your_inbox_to_confirm"
                    values={{
                      institutionName:
                        userEmailData.affiliation.institution.name,
                    }}
                    shouldUnescape
                    tOptions={{ interpolation: { escapeValue: true } }}
                    components={
                      /* eslint-disable-next-line jsx-a11y/anchor-has-content, react/jsx-key */
                      [<strong />]
                    }
                  />
                ) : (
                  <ReconfirmationInfoPromptText
                    institutionName={userEmailData.affiliation.institution.name}
                    primary={userEmailData.default}
                  />
                )}
                <br />
                {isError && (
                  <div className="text-danger">
                    {rateLimited
                      ? t('too_many_requests')
                      : t('generic_something_went_wrong')}
                  </div>
                )}
              </>
            }
            action={
              hasSent ? (
                <>
                  {isLoading ? (
                    <>
                      <LoadingSpinner loadingText={`${t('sending')}…`} />
                    </>
                  ) : (
                    <OLButton
                      variant="link"
                      disabled={state.isLoading}
                      onClick={handleRequestReconfirmation}
                      className="btn-inline-link"
                    >
                      {t('resend_confirmation_email')}
                    </OLButton>
                  )}
                </>
              ) : (
                <OLButton
                  variant="secondary"
                  disabled={isPending}
                  isLoading={isLoading}
                  onClick={handleRequestReconfirmation}
                >
                  {isLoading ? (
                    <>
                      <LoadingSpinner loadingText={`${t('sending')}…`} />
                    </>
                  ) : (
                    t('confirm_affiliation')
                  )}
                </OLButton>
              )
            }
          />
        </OLCol>
      </OLRow>
    )
  }

  return null
}

export default ReconfirmationInfo
